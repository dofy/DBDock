//! Plans use the editor connection, including its current schema and transaction.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, Column, Row};

use crate::sql::{QueryResult, SqlPool, decode_my, decode_pg};
use crate::store::{Kind, SqlProtection};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanMode {
    Explain,
    Analyze,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PlanFormat {
    PostgresJson,
    MysqlJson,
    MysqlTree,
    SqliteTree,
}

#[derive(Serialize)]
pub struct ExecutionPlan {
    format: PlanFormat,
    result: QueryResult,
}

fn skip_comment(input: &[u8], i: usize, kind: Kind) -> Result<Option<usize>> {
    let tail = &input[i..];
    let line = (tail.starts_with(b"--")
        && (kind != Kind::Mysql || tail.get(2).is_none_or(|b| b.is_ascii_whitespace() || b.is_ascii_control())))
        || (kind == Kind::Mysql && tail.starts_with(b"#"));
    if line {
        return Ok(Some(i + tail.iter().position(|b| matches!(*b, b'\n' | b'\r')).unwrap_or(tail.len())));
    }
    if !tail.starts_with(b"/*") {
        return Ok(None);
    }
    ensure!(kind != Kind::Mysql || (!tail.starts_with(b"/*!") && !tail.starts_with(b"/*M!") && !tail.starts_with(b"/*m!")),
        "Select one statement for the execution plan");
    let mut end = i + 2;
    let mut level = 1;
    while end < input.len() {
        if input[end..].starts_with(b"*/") {
            level -= 1;
            end += 2;
            if level == 0 { return Ok(Some(end)); }
        } else if kind == Kind::Postgres && input[end..].starts_with(b"/*") {
            level += 1;
            end += 2;
        } else {
            end += 1;
        }
    }
    // SQLite treats a block comment that reaches the input end as trivia.
    if matches!(kind, Kind::Sqlite | Kind::D1) { return Ok(Some(end)); }
    anyhow::bail!("Select one statement for the execution plan");
}

fn skip_trivia(bytes: &[u8], mut i: usize, kind: Kind) -> Result<usize> {
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
        } else if let Some(end) = skip_comment(bytes, i, kind)? {
            i = end;
        } else {
            break;
        }
    }
    Ok(i)
}

/// SQLite and D1 accept statement batches. Reject a second command outside
/// SQLite quotes and comments before sending the generated statement.
fn check_sqlite_boundary(bytes: &[u8], mut i: usize) -> Result<()> {
    while i < bytes.len() {
        i = skip_trivia(bytes, i, Kind::Sqlite)?;
        let Some(&byte) = bytes.get(i) else { break };
        i += 1;
        match byte {
            b';' => {
                i = skip_trivia(bytes, i, Kind::Sqlite)?;
                while bytes.get(i) == Some(&b';') {
                    i = skip_trivia(bytes, i + 1, Kind::Sqlite)?;
                }
                ensure!(i == bytes.len(), "Select one statement for the execution plan");
                break;
            }
            b'\'' | b'"' | b'`' | b'[' => {
                let closing = if byte == b'[' { b']' } else { byte };
                loop {
                    let current = bytes.get(i).copied().ok_or_else(|| anyhow::anyhow!("Select one statement for the execution plan"))?;
                    i += 1;
                    if current == closing {
                        if byte != b'[' && bytes.get(i) == Some(&closing) { i += 1; }
                        else { break; }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn plan_sql(sql: &str, kind: Kind, mode: PlanMode) -> Result<(String, PlanFormat)> {
    let bytes = sql.as_bytes();
    ensure!(!bytes.contains(&0), "Select one statement for the execution plan");
    let start = skip_trivia(bytes, 0, kind)?;
    let end = bytes[start..].iter().position(|b| !b.is_ascii_alphabetic()).map_or(bytes.len(), |n| start + n);
    let keyword = sql[start..end].to_ascii_uppercase();
    let (prefix, format) = match (kind, mode) {
        (Kind::Postgres, PlanMode::Explain) => ("EXPLAIN (FORMAT JSON)", PlanFormat::PostgresJson),
        (Kind::Postgres, PlanMode::Analyze) => ("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)", PlanFormat::PostgresJson),
        (Kind::Mysql, PlanMode::Explain) => ("EXPLAIN FORMAT=JSON", PlanFormat::MysqlJson),
        (Kind::Mysql, PlanMode::Analyze) => {
            ensure!(matches!(keyword.as_str(), "SELECT" | "WITH"), "MySQL EXPLAIN ANALYZE requires a SELECT statement");
            ("EXPLAIN ANALYZE FORMAT=TREE", PlanFormat::MysqlTree)
        }
        (Kind::Sqlite | Kind::D1, PlanMode::Explain) => {
            check_sqlite_boundary(bytes, start)?;
            ("EXPLAIN QUERY PLAN", PlanFormat::SqliteTree)
        }
        _ => anyhow::bail!("This database does not support EXPLAIN ANALYZE"),
    };
    ensure!(matches!(keyword.as_str(), "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE" |
        "MERGE" | "REPLACE" | "VALUES" | "TABLE"), "Choose a SQL statement that supports EXPLAIN");
    Ok((format!("{prefix} {sql}"), format))
}

fn check_mode(protection: SqlProtection, mode: PlanMode, confirmed: bool) -> Result<()> {
    if protection == SqlProtection::BrowseOnly {
        protection.check_execution(confirmed)?;
    }
    if mode == PlanMode::Analyze {
        ensure!(confirmed, "Confirm that EXPLAIN ANALYZE may execute this statement");
    }
    Ok(())
}

/// Preparing on PostgreSQL and MySQL requires exactly one statement on the
/// wire. Using the simple query protocol here would allow multiple commands.
macro_rules! prepared_plan {
    ($pool:expr, $sql:expr, $decode:ident) => {{
        let rows = sqlx::query(AssertSqlSafe($sql)).persistent(false).fetch_all($pool).await?;
        QueryResult {
            columns: rows.first().into_iter().flat_map(|row| row.columns().iter().map(|column| column.name().into())).collect(),
            rows: rows.iter().map(|row| (0..row.len()).map(|i| $decode(row, i)).collect()).collect(),
            ..QueryResult::default()
        }
    }};
}

impl SqlPool {
    pub async fn execution_plan(&self, sql: &str, mode: PlanMode, protection: SqlProtection, confirmed: bool) -> Result<ExecutionPlan> {
        check_mode(protection, mode, confirmed)?;
        let (sql, format) = plan_sql(sql, self.dialect(), mode)?;
        let result = match self {
            Self::Pg(pool) | Self::BrowserPg(pool) => prepared_plan!(pool, sql, decode_pg),
            Self::My(pool) | Self::BrowserMy(pool) => prepared_plan!(pool, sql, decode_my),
            Self::Lite(_) | Self::D1(_) => self.execute(sql).await?.into_iter().next().unwrap_or_default(),
        };
        Ok(ExecutionPlan { format, result })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::mysql::MySqlPoolOptions;
    use sqlx::postgres::PgPoolOptions;
    use sqlx::sqlite::SqlitePoolOptions;

    #[test]
    fn generates_estimates_and_makes_execution_explicit() {
        let sql = "SELECT * FROM items";
        assert_eq!(plan_sql(sql, Kind::Postgres, PlanMode::Explain).unwrap().0, "EXPLAIN (FORMAT JSON) SELECT * FROM items");
        assert_eq!(plan_sql(sql, Kind::Mysql, PlanMode::Explain).unwrap().0, "EXPLAIN FORMAT=JSON SELECT * FROM items");
        assert_eq!(plan_sql(sql, Kind::Sqlite, PlanMode::Explain).unwrap().0, "EXPLAIN QUERY PLAN SELECT * FROM items");
        assert!(plan_sql(sql, Kind::D1, PlanMode::Analyze).is_err());
        assert!(plan_sql("EXPLAIN ANALYZE SELECT 1", Kind::Postgres, PlanMode::Explain).is_err());
        assert!(plan_sql("UPDATE items SET id = 3", Kind::Mysql, PlanMode::Analyze).is_err());
        assert!(check_mode(SqlProtection::Confirm, PlanMode::Explain, false).is_ok());
        assert!(check_mode(SqlProtection::BrowseOnly, PlanMode::Explain, true).is_err());
        assert!(check_mode(SqlProtection::Automatic, PlanMode::Analyze, false).is_err());
        assert!(check_mode(SqlProtection::Confirm, PlanMode::Analyze, true).is_ok());
    }

    #[test]
    fn sqlite_plan_boundary_distinguishes_quoted_semicolons_and_batches() {
        for sql in [
            "/* note */ SELECT 'a; b', [字段;名], \"c;d\", `e;f`; -- after",
            "SELECT 'it''s; okay'; ; /* after; */",
            "WITH one AS (SELECT 1) SELECT * FROM one",
        ] {
            assert!(plan_sql(sql, Kind::Sqlite, PlanMode::Explain).is_ok(), "{sql}");
        }
        for sql in [
            "SELECT 1; UPDATE items SET id = 3",
            "SELECT 'one';-- hidden\nDELETE FROM items",
            "SELECT `unterminated; UPDATE items SET id = 3",
            "SELECT 1; /* note */ ; DELETE FROM items",
        ] {
            assert!(plan_sql(sql, Kind::Sqlite, PlanMode::Explain).is_err(), "{sql}");
            assert!(plan_sql(sql, Kind::D1, PlanMode::Explain).is_err(), "{sql}");
        }
    }

    #[tokio::test]
    async fn sqlite_estimate_exposes_index_and_does_not_write() {
        let db = SqlPool::Lite(SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap());
        db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT); CREATE INDEX items_title ON items(title); INSERT INTO items VALUES (1,'a')".into()).await.unwrap();
        let plan = db.execution_plan("DELETE FROM items WHERE title = 'a';", PlanMode::Explain, SqlProtection::Confirm, false).await.unwrap();
        assert_eq!(plan.format, PlanFormat::SqliteTree);
        assert!(plan.result.rows.iter().flatten().any(|cell| cell.as_str().is_some_and(|text| text.contains("items_title"))));
        assert!(db.execution_plan("SELECT 1; DELETE FROM items", PlanMode::Explain, SqlProtection::Automatic, false).await.is_err());
        assert_eq!(db.execute("SELECT COUNT(*) FROM items".into()).await.unwrap()[0].rows[0][0], 1);
    }

    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL test database"]
    async fn postgres_plan_modes_keep_estimation_and_execution_distinct() {
        let url = std::env::var("DBDOCK_TEST_POSTGRES_URL").unwrap();
        let db = SqlPool::Pg(PgPoolOptions::new().max_connections(1).connect(&url).await.unwrap());
        db.execute("CREATE TEMP TABLE plan_items (id INTEGER PRIMARY KEY); INSERT INTO plan_items VALUES (1)".into()).await.unwrap();
        let update = "UPDATE plan_items SET id = 2 WHERE id = 1";
        let estimate = db.execution_plan(update, PlanMode::Explain, SqlProtection::Confirm, false).await.unwrap();
        let json = |plan: ExecutionPlan| serde_json::from_str::<serde_json::Value>(plan.result.rows[0][0].as_str().unwrap()).unwrap();
        assert!(!json(estimate)[0]["Plan"].as_object().unwrap().contains_key("Actual Rows"));
        assert!(db.execution_plan("SELECT 1; DELETE FROM plan_items", PlanMode::Explain, SqlProtection::Automatic, false).await.is_err());
        assert!(db.execution_plan(update, PlanMode::Analyze, SqlProtection::Confirm, false).await.is_err());
        assert_eq!(db.execute("SELECT id FROM plan_items".into()).await.unwrap()[0].rows[0][0], 1);
        let measured = db.execution_plan(update, PlanMode::Analyze, SqlProtection::Confirm, true).await.unwrap();
        assert!(json(measured)[0]["Execution Time"].as_f64().is_some());
        assert_eq!(db.execute("SELECT id FROM plan_items".into()).await.unwrap()[0].rows[0][0], 2);
    }

    #[tokio::test]
    #[ignore = "requires an isolated MySQL test instance"]
    async fn mysql_plan_modes_keep_estimation_and_execution_distinct() {
        let url = std::env::var("DBDOCK_TEST_MYSQL_URL").unwrap();
        let db = SqlPool::My(MySqlPoolOptions::new().max_connections(1).connect(&url).await.unwrap());
        db.execute("CREATE DATABASE dbdock_plan; USE dbdock_plan; CREATE TABLE plan_items (id INT PRIMARY KEY); INSERT INTO plan_items VALUES (1)".into()).await.unwrap();
        let estimate = db.execution_plan("UPDATE plan_items SET id = 2 WHERE id = 1", PlanMode::Explain, SqlProtection::Confirm, false).await.unwrap();
        assert_eq!(estimate.format, PlanFormat::MysqlJson);
        assert!(serde_json::from_str::<serde_json::Value>(estimate.result.rows[0][0].as_str().unwrap()).unwrap().get("query_block").is_some());
        assert!(db.execution_plan("SELECT 1; DELETE FROM plan_items", PlanMode::Explain, SqlProtection::Automatic, false).await.is_err());
        assert_eq!(db.execute("SELECT id FROM plan_items".into()).await.unwrap()[0].rows[0][0], 1);
        db.execute("SET explain_format=JSON".into()).await.unwrap();
        let measured = db.execution_plan("SELECT * FROM plan_items", PlanMode::Analyze, SqlProtection::Confirm, true).await.unwrap();
        assert_eq!(measured.format, PlanFormat::MysqlTree);
        assert!(measured.result.rows[0][0].as_str().unwrap().contains("actual time="));
    }
}
