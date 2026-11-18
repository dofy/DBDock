//! Generate one schema change from typed inputs, without accepting SQL fragments.
use std::collections::HashSet;

use anyhow::{Result, ensure};
use serde::Deserialize;
use sqlx::AssertSqlSafe;

use crate::{sql::SqlPool, store::Kind};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ColumnType {
    Integer,
    Bigint,
    Decimal,
    Real,
    Boolean,
    Text,
    Varchar,
    Date,
    Timestamp,
    Json,
    Binary,
}

impl ColumnType {
    fn sql(self, dialect: Kind) -> &'static str {
        match (self, dialect) {
            (Self::Integer, _) | (Self::Bigint | Self::Boolean, Kind::Sqlite) => "INTEGER",
            (Self::Bigint, _) => "BIGINT",
            (Self::Decimal, _) => "DECIMAL(18, 6)",
            (Self::Real, Kind::Postgres) => "DOUBLE PRECISION",
            (Self::Real, Kind::Mysql) => "DOUBLE",
            (Self::Real, _) => "REAL",
            (Self::Boolean, _) => "BOOLEAN",
            (Self::Text, _) | (Self::Json | Self::Date | Self::Timestamp, Kind::Sqlite) => "TEXT",
            (Self::Varchar, _) => "VARCHAR(255)",
            (Self::Date, _) => "DATE",
            (Self::Timestamp, Kind::Mysql) => "DATETIME",
            (Self::Timestamp, _) => "TIMESTAMP",
            (Self::Json, Kind::Postgres) => "JSONB",
            (Self::Json, _) => "JSON",
            (Self::Binary, Kind::Postgres) => "BYTEA",
            (Self::Binary, _) => "BLOB",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDraft {
    name: String,
    data_type: ColumnType,
    not_null: bool,
    primary_key: bool,
    default_value: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SchemaChange {
    Create {
        columns: Vec<ColumnDraft>,
    },
    Add {
        column: ColumnDraft,
    },
    Rename {
        column: String,
        new_name: String,
    },
    Drop {
        column: String,
    },
    Type {
        column: String,
        data_type: ColumnType,
    },
    Nullability {
        column: String,
        not_null: bool,
    },
    Default {
        column: String,
        value: Option<String>,
    },
}

pub fn identifier(name: &str) -> Result<()> {
    ensure!(
        !name.trim().is_empty() && !name.chars().any(char::is_control),
        "Enter a valid database identifier"
    );
    Ok(())
}

impl SqlPool {
    pub async fn apply_schema(&self, sql: String) -> Result<()> {
        if let Self::Lite(pool) = self {
            let mut tx = pool.begin().await?;
            sqlx::raw_sql(AssertSqlSafe(sql)).execute(&mut *tx).await?;
            tx.commit().await?;
        } else {
            self.execute(sql).await?;
        }
        Ok(())
    }

    pub fn schema_sql(&self, schema: &str, table: &str, change: &SchemaChange) -> Result<String> {
        identifier(schema)?;
        identifier(table)?;
        let table = self.table_ref(schema, table);
        let dialect = self.dialect();
        let quoted = |name: &str| -> Result<String> {
            identifier(name)?;
            Ok(self.quote_ident(name))
        };
        let literal = |value: &str| -> Result<String> {
            ensure!(
                !value.contains('\0'),
                "Defaults cannot contain NUL characters"
            );
            Ok(self.quote_lit(value))
        };
        let definition = |column: &ColumnDraft| -> Result<String> {
            let mut sql = format!(
                "{} {}",
                quoted(&column.name)?,
                column.data_type.sql(dialect)
            );
            if column.not_null || column.primary_key {
                sql.push_str(" NOT NULL");
            }
            if let Some(value) = &column.default_value {
                sql.push_str(&format!(" DEFAULT {}", literal(value)?));
            }
            Ok(sql)
        };
        let clause = match change {
            SchemaChange::Create { columns } => {
                ensure!(
                    (1..=100).contains(&columns.len()),
                    "A new table needs between 1 and 100 columns"
                );
                let mut names = HashSet::new();
                let mut definitions = Vec::with_capacity(columns.len() + 1);
                let mut keys = Vec::new();
                for column in columns {
                    let comparable = if dialect == Kind::Postgres {
                        column.name.clone()
                    } else {
                        column.name.to_ascii_lowercase()
                    };
                    ensure!(
                        names.insert(comparable),
                        "Duplicate column name: {}",
                        column.name
                    );
                    definitions.push(definition(column)?);
                    if column.primary_key {
                        keys.push(quoted(&column.name)?);
                    }
                }
                if !keys.is_empty() {
                    definitions.push(format!("PRIMARY KEY ({})", keys.join(", ")));
                }
                return Ok(format!(
                    "CREATE TABLE {table} (\n  {}\n)",
                    definitions.join(",\n  ")
                ));
            }
            SchemaChange::Add { column } => {
                ensure!(
                    !column.primary_key,
                    "Adding a primary key is unavailable in this editor"
                );
                ensure!(
                    dialect != Kind::Sqlite || !column.not_null || column.default_value.is_some(),
                    "SQLite and D1 require a default for a new NOT NULL column"
                );
                format!("ADD COLUMN {}", definition(column)?)
            }
            SchemaChange::Rename { column, new_name } => {
                format!("RENAME COLUMN {} TO {}", quoted(column)?, quoted(new_name)?)
            }
            SchemaChange::Drop { column } => format!("DROP COLUMN {}", quoted(column)?),
            SchemaChange::Type { column, data_type } => {
                ensure!(
                    dialect == Kind::Postgres,
                    "Changing an existing column type here requires PostgreSQL"
                );
                format!(
                    "ALTER COLUMN {} TYPE {}",
                    quoted(column)?,
                    data_type.sql(dialect)
                )
            }
            SchemaChange::Nullability { column, not_null } => {
                ensure!(
                    dialect == Kind::Postgres,
                    "Changing existing nullability here requires PostgreSQL"
                );
                let action = if *not_null { "SET" } else { "DROP" };
                format!("ALTER COLUMN {} {action} NOT NULL", quoted(column)?)
            }
            SchemaChange::Default { column, value } => {
                ensure!(
                    dialect != Kind::Sqlite,
                    "Changing an existing default here requires PostgreSQL or MySQL"
                );
                let action = match value {
                    Some(value) => format!("SET DEFAULT {}", literal(value)?),
                    None => "DROP DEFAULT".to_string(),
                };
                format!("ALTER COLUMN {} {action}", quoted(column)?)
            }
        };
        Ok(format!("ALTER TABLE {table} {clause}"))
    }
}
