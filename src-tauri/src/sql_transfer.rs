//! Move table data between a database and a user-selected local file.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use futures::TryStreamExt;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{AssertSqlSafe, Column, Executor, Row, SqlSafeStr, TypeInfo, ValueRef};
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::{
    sql::{MAX_ROWS, SqlPool, decode_lite, decode_my, decode_pg},
    sql_schema::identifier,
    store::Kind,
};

const MAX_IMPORT_ROWS: usize = 5_000;
const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;
const D1_IMPORT_BYTES: usize = 90_000;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

impl SqlPool {
    pub async fn import_rows(
        &self,
        schema: &str,
        table: &str,
        columns: Vec<String>,
        rows: Vec<Vec<Value>>,
    ) -> Result<usize> {
        identifier(schema)?;
        identifier(table)?;
        ensure!(
            !columns.is_empty() && (1..=MAX_IMPORT_ROWS).contains(&rows.len()),
            "Map at least one column and import between 1 and 5,000 rows"
        );
        ensure!(
            serde_json::to_vec(&rows)?.len() <= MAX_IMPORT_BYTES,
            "Mapped data exceeds 5 MiB"
        );
        let table_info = self.tables(schema).await?;
        ensure!(
            table_info
                .iter()
                .any(|item| item.name == table && item.kind == "table"),
            "Import destination is not a table"
        );
        let structure = self.structure(schema, table).await?;
        let available: HashMap<&str, &str> = structure
            .rows
            .iter()
            .filter_map(|row| Some((row.first()?.as_str()?, row.get(1)?.as_str()?)))
            .collect();
        let mut unique = HashSet::new();
        let mut binary = Vec::with_capacity(columns.len());
        for col in &columns {
            let ty = available
                .get(col.as_str())
                .with_context(|| format!("Invalid destination column: {col}"))?;
            ensure!(unique.insert(col), "Duplicate destination column: {col}");
            let base = ty
                .split('(')
                .next()
                .unwrap_or(ty)
                .trim()
                .to_ascii_uppercase();
            binary.push(matches!(
                base.as_str(),
                "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "BYTEA"
            ));
        }
        self.ensure_transactional(schema, table).await?;

        let target = self.table_ref(schema, table);
        let columns = columns
            .iter()
            .map(|col| self.quote_ident(col))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statements = Vec::new();
        let prefix = format!("INSERT INTO {target} ({columns}) VALUES ");
        let mut batch = prefix.clone();
        let count = rows.len();
        let mut batch_count = 0;
        for row in rows {
            ensure!(
                row.len() == unique.len()
                    && row
                        .iter()
                        .all(|value| !value.is_object() && !value.is_array()),
                "Invalid mapped row"
            );
            let values = row
                .iter()
                .zip(&binary)
                .map(|(value, binary)| {
                    if !binary || value.is_null() {
                        return Ok(self.value_lit(value));
                    }
                    let hex = value
                        .as_str()
                        .and_then(|text| text.strip_prefix("0x"))
                        .context("Binary values must use 0x followed by hexadecimal bytes")?;
                    ensure!(
                        hex.len().is_multiple_of(2) && hex.bytes().all(|b| b.is_ascii_hexdigit()),
                        "Invalid hexadecimal binary value"
                    );
                    Ok(if self.dialect() == Kind::Postgres {
                        format!("pg_catalog.decode('{hex}', 'hex')")
                    } else {
                        format!("X'{hex}'")
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let tuple = format!("({})", values.join(", "));
            if batch_count > 0 && batch.len() + tuple.len() + 2 > 64 * 1024 {
                statements.push((std::mem::replace(&mut batch, prefix.clone()), batch_count));
                batch_count = 0;
            }
            if batch_count > 0 {
                batch.push_str(", ");
            }
            batch.push_str(&tuple);
            batch_count += 1;
        }
        statements.push((batch, batch_count));

        macro_rules! insert {
            ($pool:expr) => {{
                let mut tx = $pool.begin().await?;
                for (statement, count) in &statements {
                    let effect = sqlx::raw_sql(AssertSqlSafe(statement.as_str()))
                        .execute(&mut *tx)
                        .await?;
                    ensure!(
                        effect.rows_affected() == *count,
                        "Some imported rows were rejected; the import was rolled back"
                    );
                }
                tx.commit().await?;
            }};
        }
        match self {
            Self::My(p) | Self::BrowserMy(p) => insert!(p),
            Self::Pg(p) | Self::BrowserPg(p) => insert!(p),
            Self::Lite(p) => insert!(p),
            Self::D1(c) => {
                let sql = statements.into_iter().flat_map(|(statement, count)| [
                    statement,
                    format!("SELECT CASE WHEN changes() = {count} THEN 1 ELSE json('dbdock: rows skipped') END"),
                ]).collect::<Vec<_>>().join(";\n");
                ensure!(
                    sql.len() <= D1_IMPORT_BYTES,
                    "D1 import exceeds 90 KB of SQL; split the file into smaller imports"
                );
                c.query(&sql).await?;
            }
        }
        Ok(count)
    }

    pub async fn export_table(
        &self,
        schema: &str,
        table: &str,
        path: &Path,
        format: ExportFormat,
    ) -> Result<u64> {
        identifier(schema)?;
        identifier(table)?;
        let sql = format!("SELECT * FROM {}", self.table_ref(schema, table));
        let mut output = TableWriter::new(path, format).await?;
        macro_rules! stream {
            ($pool:expr, $decode:ident) => {{
                let mut conn = $pool.acquire().await?;
                let described = (&mut *conn)
                    .describe(AssertSqlSafe(sql.as_str()).into_sql_str())
                    .await?;
                let columns = described
                    .columns()
                    .iter()
                    .map(|col| col.name().to_string())
                    .collect::<Vec<_>>();
                output.header(&columns).await?;
                let mut rows = sqlx::raw_sql(AssertSqlSafe(sql.as_str())).fetch(&mut *conn);
                while let Some(row) = rows.try_next().await? {
                    let values = (0..row.len())
                        .map(|i| {
                            let raw = row.try_get_raw(i)?;
                            let kind = raw.type_info();
                            let name = kind.name();
                            if !raw.is_null()
                                && matches!(
                                    name,
                                    "BLOB"
                                        | "TINYBLOB"
                                        | "MEDIUMBLOB"
                                        | "LONGBLOB"
                                        | "BINARY"
                                        | "VARBINARY"
                                        | "BYTEA"
                                )
                            {
                                let bytes = row.try_get_unchecked::<Vec<u8>, _>(i)?;
                                Ok(Value::String(blob_hex(bytes)))
                            } else {
                                Ok($decode(&row, i))
                            }
                        })
                        .collect::<Result<Vec<_>>>()?;
                    output.row(&values).await?;
                }
            }};
        }
        match self {
            Self::My(p) | Self::BrowserMy(p) => stream!(p, decode_my),
            Self::Pg(p) | Self::BrowserPg(p) => stream!(p, decode_pg),
            Self::Lite(p) => stream!(p, decode_lite),
            Self::D1(c) => {
                let result = c
                    .export_data(&format!("{sql} LIMIT {}", MAX_ROWS + 1))
                    .await?
                    .into_iter()
                    .next()
                    .context("No result from D1")?;
                ensure!(
                    !result.truncated,
                    "D1 export exceeds 5,000 rows; use a filtered SQL query instead"
                );
                let columns = if result.columns.is_empty() {
                    self.structure(schema, table)
                        .await?
                        .rows
                        .iter()
                        .filter_map(|row| row.first()?.as_str().map(str::to_owned))
                        .collect()
                } else {
                    result.columns
                };
                output.header(&columns).await?;
                for row in &result.rows {
                    output.row(row).await?;
                }
            }
        }
        output.finish(path).await
    }
}

struct TemporaryExport(PathBuf);

impl Drop for TemporaryExport {
    fn drop(&mut self) {
        // The destination is replaced only after the complete export is flushed.
        let _ = std::fs::remove_file(&self.0);
    }
}

struct TableWriter {
    file: BufWriter<tokio::fs::File>,
    temp: TemporaryExport,
    format: ExportFormat,
    rows: u64,
}

impl TableWriter {
    async fn new(destination: &Path, format: ExportFormat) -> Result<Self> {
        let parent = destination.parent().context("Invalid export path")?;
        let path = parent.join(format!(".dbdock-export-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(&path).await?;
        Ok(Self {
            file: BufWriter::new(file),
            temp: TemporaryExport(path),
            format,
            rows: 0,
        })
    }

    async fn header(&mut self, columns: &[String]) -> Result<()> {
        match self.format {
            ExportFormat::Csv => {
                self.record(
                    &columns
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect::<Vec<_>>(),
                )
                .await?
            }
            ExportFormat::Json => {
                self.file.write_all(b"{\"columns\":").await?;
                self.file.write_all(&serde_json::to_vec(columns)?).await?;
                self.file.write_all(b",\"rows\":[\n").await?;
            }
        }
        Ok(())
    }

    async fn row(&mut self, values: &[Value]) -> Result<()> {
        if matches!(self.format, ExportFormat::Json) && self.rows > 0 {
            self.file.write_all(b",\n").await?;
        }
        self.record(values).await?;
        self.rows += 1;
        Ok(())
    }

    async fn record(&mut self, values: &[Value]) -> Result<()> {
        let bytes = match self.format {
            ExportFormat::Json => serde_json::to_vec(values)?,
            ExportFormat::Csv => {
                let cells = values.iter().map(csv_cell).collect::<Vec<_>>();
                (cells.join(",") + "\r\n").into_bytes()
            }
        };
        self.file.write_all(&bytes).await?;
        Ok(())
    }

    async fn finish(mut self, destination: &Path) -> Result<u64> {
        if matches!(self.format, ExportFormat::Json) {
            self.file.write_all(b"\n]}\n").await?;
        }
        self.file.flush().await?;
        self.file.get_ref().sync_all().await?;
        tokio::fs::rename(&self.temp.0, destination).await?;
        Ok(self.rows)
    }
}

pub(crate) fn blob_hex(bytes: Vec<u8>) -> String {
    use std::fmt::Write;
    let mut hex = String::with_capacity(2 + bytes.len() * 2);
    hex.push_str("0x");
    for byte in bytes {
        write!(hex, "{byte:02x}").expect("writing to String");
    }
    hex
}

fn csv_cell(value: &Value) -> String {
    if value.is_null() {
        return String::new();
    }
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    let formula = value.is_string()
        && (text.starts_with(['\t', '\r', '\n'])
            || text.trim_start().starts_with(['=', '+', '-', '@']));
    let prefix = if formula { "'" } else { "" };
    format!("\"{prefix}{}\"", text.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_schema::SchemaChange;
    use serde_json::json;
    use sqlx::{mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions};

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("dbdock-transfer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        path
    }

    async fn change(db: &SqlPool, schema: &str, table: &str, draft: Value) {
        let change: SchemaChange = serde_json::from_value(draft).unwrap();
        let sql = db.schema_sql(schema, table, &change).unwrap();
        db.apply_schema(sql).await.unwrap();
    }

    async fn exercise(db: SqlPool, schema: &str) {
        let table = "transfer qa";
        change(&db, schema, table, json!({"op":"create","columns":[
            {"name":"id", "dataType":"integer", "notNull":false, "primaryKey":true, "defaultValue":null},
            {"name":"label", "dataType":"text", "notNull":false, "primaryKey":false, "defaultValue":null},
            {"name":"bytes", "dataType":"binary", "notNull":false, "primaryKey":false, "defaultValue":null}
        ]})).await;
        change(&db, schema, table, json!({"op":"add","column":{
            "name":"status", "dataType":"varchar", "notNull":true, "primaryKey":false, "defaultValue":"it's new"
        }})).await;
        change(
            &db,
            schema,
            table,
            json!({"op":"rename","column":"status","newName":"state"}),
        )
        .await;
        if db.dialect() != Kind::Sqlite {
            change(
                &db,
                schema,
                table,
                json!({"op":"default","column":"state","value":"it's new"}),
            )
            .await;
        }
        if db.dialect() == Kind::Postgres {
            change(
                &db,
                schema,
                table,
                json!({"op":"type","column":"id","dataType":"bigint"}),
            )
            .await;
            change(
                &db,
                schema,
                table,
                json!({"op":"nullability","column":"state","notNull":false}),
            )
            .await;
        }
        let names = ["id", "label", "bytes"].map(str::to_owned).to_vec();
        let hex = format!("0x{}", "ff".repeat(4200));
        assert_eq!(
            db.import_rows(
                schema,
                table,
                names.clone(),
                vec![vec![
                    json!(1),
                    json!("quote '\" and backslash \\"),
                    json!(hex)
                ]]
            )
            .await
            .unwrap(),
            1
        );

        // Force more than one INSERT, then fail in a later batch.
        let failure = vec![
            vec![json!(2), json!("x".repeat(65_536)), Value::Null],
            vec![json!(1), json!("duplicate"), Value::Null],
        ];
        assert!(db.import_rows(schema, table, names, failure).await.is_err());
        let dir = temp_dir();
        let path = dir.join("result.json");
        assert_eq!(
            db.export_table(schema, table, &path, ExportFormat::Json)
                .await
                .unwrap(),
            1
        );
        let result: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(result["columns"], json!(["id", "label", "bytes", "state"]));
        assert_eq!(
            result["rows"],
            json!([[1, "quote '\" and backslash \\", hex, "it's new"]])
        );
        change(&db, schema, table, json!({"op":"drop","column":"state"})).await;
        assert!(
            db.export_table(schema, "no such table", &path, ExportFormat::Json)
                .await
                .is_err()
        );
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after, result);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
        db.execute(format!("DROP TABLE {}", db.table_ref(schema, table)))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn sqlite_schema_import_and_export() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        exercise(SqlPool::Lite(pool), "main").await;
    }

    #[tokio::test]
    async fn sqlite_csv_export_has_headers_and_does_not_truncate() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let db = SqlPool::Lite(pool);
        db.execute("CREATE TABLE sample (id INTEGER, value TEXT)".into())
            .await
            .unwrap();
        let dir = temp_dir();
        let path = dir.join("table.csv");
        assert_eq!(
            db.export_table("main", "sample", &path, ExportFormat::Csv)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "\"id\",\"value\"\r\n"
        );
        db.execute("WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<5001) INSERT INTO sample SELECT n, '=formula' FROM rows".into()).await.unwrap();
        assert_eq!(
            db.export_table("main", "sample", &path, ExportFormat::Csv)
                .await
                .unwrap(),
            5001
        );
        let csv = std::fs::read_to_string(path).unwrap();
        assert_eq!(csv.lines().count(), 5002);
        assert!(csv.contains("\"5001\",\"'=formula\""));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL test database"]
    async fn postgres_schema_import_and_export() {
        let url = std::env::var("DBDOCK_TEST_POSTGRES_URL").unwrap();
        let db = PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        exercise(SqlPool::BrowserPg(db), "public").await;
    }

    #[tokio::test]
    #[ignore = "requires an isolated MySQL test database"]
    async fn mysql_schema_import_and_export() {
        let url = std::env::var("DBDOCK_TEST_MYSQL_URL").unwrap();
        let db = MySqlPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        exercise(SqlPool::BrowserMy(db), "dbdock_test").await;
    }
}
