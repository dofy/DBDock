import { localizeError } from "./i18n";
import { invoke } from "@tauri-apps/api/core";

export type Kind = "mysql" | "postgres" | "sqlite" | "redis" | "d1" | "mongodb";

/** Kinds handled by the SQL workspace. */
export const isSql = (k: Kind) => k === "mysql" || k === "postgres" || k === "sqlite" || k === "d1";
/** Kinds reached over the network (SSH tunnel possible). */
export const isTunnelable = (k: Kind) => k !== "sqlite" && k !== "d1";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: "password" | "key";
  keyPath: string;
}

export type SqlProtection = "automatic" | "confirm" | "browseOnly";

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: Kind;
  host: string;
  port: number;
  user: string;
  database: string;
  file: string;
  redisDb: number;
  /** Cloudflare account ID (D1). */
  cfAccountId: string;
  /** Extra options as a query string (MongoDB), e.g. authSource=admin&tls=true */
  options: string;
  color: string;
  /** local | development | testing | staging | production | "" */
  env: string;
  sqlProtection?: SqlProtection;
  /** Folder path, e.g. "Acme / AI". */
  group: string;
  ssh: SshConfig;
}

/** undefined = keep stored value, "" = clear it. */
export interface SecretsInput {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export interface SessionInfo {
  sessionId: string;
  kind: Kind;
  serverVersion: string;
  defaultSchema: string;
  sqlProtection: SqlProtection;
}

export type Cell = string | number | boolean | null;

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  rowsAffected: number | null;
  truncated: boolean;
  elapsedMs: number;
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
}

export interface TableData {
  sql: string;
  result: QueryResult;
  hasMore: boolean;
  rowVersions: string[];
}

export type MetadataKind = "indexes" | "foreignKeys";
export type FilterOperator = "equals" | "notEquals" | "contains" | "greater" | "less" | "isNull" | "isNotNull";
export type FilterCondition = { column: string; operator: FilterOperator; value: string };
export type TableFilter = { matchAny: boolean; conditions: FilterCondition[] };

export type ColumnType = "integer" | "bigint" | "decimal" | "real" | "boolean" | "text" | "varchar" | "date" | "timestamp" | "json" | "binary";
export interface ColumnDraft {
  name: string;
  dataType: ColumnType;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}
export type SchemaChange =
  | { op: "create"; columns: ColumnDraft[] }
  | { op: "add"; column: ColumnDraft }
  | { op: "rename"; column: string; newName: string }
  | { op: "drop"; column: string }
  | { op: "type"; column: string; dataType: ColumnType }
  | { op: "nullability"; column: string; notNull: boolean }
  | { op: "default"; column: string; value: string | null };

export type Row = Record<string, Cell>;

/** A MongoDB document in relaxed Extended JSON. */
export type Doc = Record<string, unknown>;

export type Change =
  | { op: "update"; key: Row; set: Row; version: string }
  | { op: "delete"; key: Row; version: string }
  | { op: "insert"; values: Row };

export interface KeyInfo {
  key: string;
  id: string;
  type: string;
  ttl: number;
}

export interface KeyValue extends KeyInfo {
  size: number;
  value: unknown;
  truncated: boolean;
}

export const DEFAULT_PORT: Record<Kind, number> = {
  mysql: 3306,
  postgres: 5432,
  sqlite: 0,
  redis: 6379,
  d1: 0,
  mongodb: 27017,
};

export const ENVS = ["local", "development", "testing", "staging", "production"] as const;

export const ENV_LABEL: Record<string, string> = {
  local: "LOCAL",
  development: "DEV",
  testing: "TEST",
  staging: "STAGING",
  production: "PROD",
};

export const KIND_LABEL: Record<Kind, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
  redis: "Redis",
  d1: "Cloudflare D1",
  mongodb: "MongoDB",
};

export function blankConnection(kind: Kind = "mysql"): ConnectionConfig {
  return {
    id: "",
    name: "",
    kind,
    host: kind === "sqlite" || kind === "d1" ? "" : "127.0.0.1",
    port: DEFAULT_PORT[kind],
    user: kind === "mysql" ? "root" : kind === "postgres" ? "postgres" : "",
    database: "",
    file: "",
    redisDb: 0,
    cfAccountId: "",
    options: "",
    color: "#6b8afd",
    env: "",
    group: "",
    ssh: { enabled: false, host: "", port: 22, user: "", auth: "key", keyPath: "" },
  };
}

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, secrets: SecretsInput) =>
    invoke<ConnectionConfig>("save_connection", { config, secrets }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  exportConnections: (path: string, ids: string[] | undefined, includeSecrets: boolean, passphrase?: string) =>
    invoke<number>("export_connections", { path, ids, includeSecrets, passphrase }),
  inspectConnectionsFile: (path: string) => invoke<{ encrypted: boolean; count: number | null }>("inspect_connections_file", { path }),
  importConnections: (path: string, passphrase?: string) =>
    invoke<{ added: number; updated: number; withSecrets: number }>("import_connections", { path, passphrase }),
  listGroups: () => invoke<string[]>("list_groups"),
  createGroup: (path: string) => invoke<string>("create_group", { path }),
  renameGroup: (from: string, to: string) => invoke<number>("rename_group", { from, to }),
  deleteGroup: (path: string, moveTo: string) => invoke<number>("delete_group", { path, moveTo }),
  moveConnections: (ids: string[], group: string) => invoke<number>("move_connections", { ids, group }),
  deleteConnections: (ids: string[]) => invoke<number>("delete_connections", { ids }),
  testConnection: (config: ConnectionConfig, secrets: SecretsInput) =>
    invoke<string>("test_connection", { config, secrets }),
  checkSavedConnection: (id: string) => invoke<void>("check_saved_connection", { id }),
  beginConnect: (attemptId: string) => invoke<void>("begin_connect", { attemptId }),
  cancelConnect: (attemptId: string) => invoke<void>("cancel_connect", { attemptId }),
  connect: (id: string, attemptId: string, database?: string) => invoke<SessionInfo>("connect", { id, attemptId, database }),
  disconnect: (sessionId: string) => invoke<void>("disconnect", { sessionId }),

  readSqlFile: (path: string) => invoke<string>("read_sql_file", { path }),
  writeSqlFile: (path: string, contents: string) => invoke<void>("write_sql_file", { path, contents }),

  databases: (sessionId: string) => invoke<string[]>("sql_databases", { sessionId }),
  schemas: (sessionId: string) => invoke<string[]>("sql_schemas", { sessionId }),
  tables: (sessionId: string, schema: string) => invoke<TableInfo[]>("sql_tables", { sessionId, schema }),
  structure: (sessionId: string, schema: string, table: string, requestId: string) =>
    invoke<QueryResult>("sql_structure", { sessionId, schema, table, requestId }),
  tableMetadata: (sessionId: string, schema: string, table: string, kind: MetadataKind, requestId: string) =>
    invoke<QueryResult>("sql_table_metadata", { sessionId, schema, table, kind, requestId }),
  tableData: (args: {
    sessionId: string;
    requestId: string;
    schema: string;
    table: string;
    limit: number;
    offset: number;
    orderBy?: string;
    orderDesc: boolean;
    filter?: string;
    visualFilter?: TableFilter;
    captureVersions: boolean;
  }) => invoke<TableData>("sql_table_data", args),
  sqlNeedsConfirmation: (sessionId: string, sql: string) =>
    invoke<boolean>("sql_needs_confirmation", { sessionId, sql }),
  execute: (sessionId: string, sql: string, confirmed: boolean) => invoke<QueryResult[]>("sql_execute", { sessionId, sql, confirmed }),
  cancel: (sessionId: string) => invoke<void>("sql_cancel", { sessionId }),
  columns: (sessionId: string, schema: string) => invoke<Record<string, string[]>>("sql_columns", { sessionId, schema }),
  previewChanges: (sessionId: string, schema: string, table: string, changes: Change[]) =>
    invoke<string[]>("sql_preview_changes", { sessionId, schema, table, changes }),
  applyChanges: (sessionId: string, schema: string, table: string, changes: Change[], confirmed: boolean) =>
    invoke<number>("sql_apply_changes", { sessionId, schema, table, changes, confirmed }),

  previewSchema: (sessionId: string, schema: string, table: string, change: SchemaChange) =>
    invoke<string>("sql_preview_schema", { sessionId, schema, table, change }),
  applySchema: (sessionId: string, schema: string, table: string, change: SchemaChange, confirmed: boolean) =>
    invoke<void>("sql_apply_schema", { sessionId, schema, table, change, confirmed }),
  readTableFile: (path: string) => invoke<string>("read_table_file", { path }),
  importRows: (sessionId: string, schema: string, table: string, columns: string[], rows: Cell[][], confirmed: boolean) =>
    invoke<number>("sql_import_rows", { sessionId, schema, table, columns, rows, confirmed }),
  exportTable: (sessionId: string, schema: string, table: string, path: string, format: "csv" | "json", requestId: string) =>
    invoke<number>("sql_export_table", { sessionId, schema, table, path, format, requestId }),

  mongoDatabases: (sessionId: string) => invoke<string[]>("mongo_databases", { sessionId }),
  mongoCollections: (sessionId: string, db: string) => invoke<string[]>("mongo_collections", { sessionId, db }),
  mongoFind: (args: { sessionId: string; db: string; coll: string; filter?: string; sort?: string; projection?: string; skip: number; limit: number }) =>
    invoke<{ docs: Doc[]; hasMore: boolean; elapsedMs: number }>("mongo_find", args),
  mongoCount: (sessionId: string, db: string, coll: string, filter?: string) => invoke<number>("mongo_count", { sessionId, db, coll, filter }),
  mongoInsert: (sessionId: string, db: string, coll: string, doc: unknown) => invoke<unknown>("mongo_insert", { sessionId, db, coll, doc }),
  mongoReplace: (sessionId: string, db: string, coll: string, id: unknown, doc: unknown) => invoke<void>("mongo_replace", { sessionId, db, coll, id, doc }),
  mongoDelete: (sessionId: string, db: string, coll: string, ids: unknown[]) => invoke<number>("mongo_delete", { sessionId, db, coll, ids }),
  mongoIndexes: (sessionId: string, db: string, coll: string) => invoke<Doc[]>("mongo_indexes", { sessionId, db, coll }),
  mongoShell: (sessionId: string, db: string, line: string) =>
    invoke<{ kind: "docs" | "value"; docs: Doc[]; value: unknown; elapsedMs: number; db: string | null }>("mongo_shell", { sessionId, db, line }),
  redisScan: (sessionId: string, cursor: number, pattern: string, count: number) =>
    invoke<{ cursor: number; keys: KeyInfo[] }>("redis_scan", { sessionId, cursor, pattern, count }),
  redisGet: (sessionId: string, key: string) => invoke<KeyValue>("redis_get", { sessionId, key }),
  redisDelete: (sessionId: string, key: string) => invoke<number>("redis_delete", { sessionId, key }),
  redisCommand: (sessionId: string, line: string) => invoke<unknown>("redis_command", { sessionId, line }),
  redisSelect: (sessionId: string, db?: number) =>
    invoke<{ db: number; dbsize: number }>("redis_select", { sessionId, db }),
};

export const errorDiagnostic = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e) ?? String(e);

export const errText = (e: unknown): string => localizeError(errorDiagnostic(e));

export function fmtTtl(ms: number): string {
  if (ms === -1) return "∞";
  if (ms === -2) return "gone";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Register before issuing the read so cancellation also works during startup. */
export function cancellableBrowserRequest<T>(run: (requestId: string) => Promise<T>) {
  const requestId = crypto.randomUUID();
  let cancelled = false;
  const registered = invoke<void>("begin_browser_request", { requestId });
  const promise = registered.then(async () => {
    if (cancelled) {
      await invoke<void>("cancel_browser_request", { requestId });
      throw new Error("browser request cancelled");
    }
    return run(requestId);
  });
  return { promise, cancel: () => {
    cancelled = true;
    void registered.then(() => invoke<void>("cancel_browser_request", { requestId })).catch(() => {});
  } };
}
