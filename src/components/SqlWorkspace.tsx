import { t, tf } from "../i18n";
import { tableListStatus } from "../tableListStatus";
import { SqlHistory } from "../sqlHistory";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText, type SessionInfo, type TableInfo } from "../api";
import { createCompletionCatalog } from "../sqlCompletionCatalog";
import { TableView } from "./TableView";
import { QueryView } from "./QueryView";
import { ResultEmpty } from "./DataGrid";
import { Database, FileCode, LockKeyhole, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useFeedbackDialog } from "./FeedbackDialog";
import { SchemaEditor } from "./SchemaEditor";
import { EnvBadge } from "./Home";
import { useToast } from "./Toast";
import type { NavigationCatalog, NavigationTarget } from "../navigation";

type ObjectTarget = Extract<NavigationTarget, { type: "schema" | "table" }>;

type Tab =
  | { id: string; type: "table"; schema: string; table: string; isView: boolean }
  | { id: string; type: "query"; title: string; sql: string };

interface Props {
  session: SessionInfo;
  connectionId: string;
  connectionName: string;
  database: string;
  env: string;
  history: SqlHistory;
  visible: boolean;
  showQuick: boolean;
  onCatalog: (catalog: NavigationCatalog) => void;
  navigationRequest?: { target: ObjectTarget };
  onNavigate: (target: NavigationTarget) => void;
  onVisit: (target: NavigationTarget) => void;
  showTabNumbers: boolean;
  dark: boolean;
  dirtyTabs: React.MutableRefObject<Map<string, Map<string, "dirty" | "busy">>>;
}

let seq = 0;
const newId = () => `t${++seq}`;

export function SqlWorkspace({ session, connectionId, connectionName, database, env, history, visible, showQuick, onCatalog,
  navigationRequest, onNavigate, onVisit, showTabNumbers, dark, dirtyTabs }: Props) {
  const sid = session.sessionId;
  const isMysql = session.kind === "mysql";
  const isPostgres = session.kind === "postgres";
  const toast = useToast();
  const { ask, message } = useFeedbackDialog();
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState(session.defaultSchema || "");
  const [postgresDatabases, setPostgresDatabases] = useState<string[]>([]);
  const [databaseStatus, setDatabaseStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [tableState, setTableState] = useState<{ schema: string; status: "loading" | "ready" | "error"; items: TableInfo[]; error?: string }>({ schema: "", status: "loading", items: [] });
  const [schemasStatus, setSchemasStatus] = useState<"loading" | "ready" | "error">("loading");
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaReload, setSchemaReload] = useState(0);
  const tableRequest = useRef(0);
  const navigationEpoch = useRef(0);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() => [{ id: newId(), type: "query", title: "Query 1", sql: "" }]);
  const [active, setActive] = useState<string | null>(() => tabs[0].id);
  const [focusRequest, setFocusRequest] = useState(0);
  const lastQueryId = useRef(active);
  const selectTab = useCallback((id: string) => {
    setActive(id);
    setFocusRequest((request) => request + 1);
  }, []);
  const completionCatalog = useMemo(() => createCompletionCatalog(
    (name) => api.columns(sid, name),
    () => api.completionSession(sid),
    (schema, table) => api.completionForeignKeys(sid, schema, table),
  ), [sid]);
  const [completionRevision, setCompletionRevision] = useState(0);
  const refreshCompletion = useCallback((clearColumns: boolean) => {
    completionCatalog.invalidate(clearColumns);
    setCompletionRevision((version) => version + 1);
  }, [completionCatalog]);
  const [, setHistoryVersion] = useState(0);

  useEffect(() => {
    let current = true;
    setSchemasStatus("loading");
    setSchemaError(null);
    api.schemas(sid).then((s) => {
      if (!current) return;
      setSchemas(s);
      if (!isMysql) setSchema((cur) => cur || s[0] || "");
      setSchemasStatus("ready");
    }).catch((e) => {
      if (!current) return;
      setSchemaError(errText(e));
      setSchemasStatus("error");
    });
    return () => { current = false; };
  }, [sid, schemaReload, isMysql]);

  const loadTables = useCallback(() => {
    if (!schema) return;
    const request = ++tableRequest.current;
    setTableState({ schema, status: "loading", items: [] });
    api.tables(sid, schema).then((items) => {
      if (request === tableRequest.current) setTableState({ schema, status: "ready", items });
    }).catch((e) => {
      if (request === tableRequest.current) setTableState({ schema, status: "error", items: [], error: errText(e) });
    });
  }, [sid, schema]);

  const refreshTables = (name = schema) => {
    refreshCompletion(false);
    if (name) completionCatalog.forget(name);
    if (name === schema) loadTables();
  };

  useEffect(() => {
    loadTables();
    return () => { tableRequest.current++; };
  }, [loadTables]);

  const tables = useMemo(() => tableState.schema === schema ? tableState.items : [], [tableState, schema]);
  const tableError = tableState.schema === schema && tableState.status === "error" ? tableState.error : null;

  useEffect(() => {
    const cycle = (event: Event) => {
      const { sessionId, direction, index } = (event as CustomEvent<{ sessionId: string; direction?: number; index?: number }>).detail;
      if (sessionId !== sid || !tabs.length) return;
      navigationEpoch.current++;
      if (index !== undefined) {
        if (index >= 0 && index < tabs.length) selectTab(tabs[index].id);
        return;
      }
      setFocusRequest((request) => request + 1);
      setActive((current) => {
        const currentIndex = tabs.findIndex((tab) => tab.id === current);
        return tabs[(currentIndex + (direction ?? 1) + tabs.length) % tabs.length].id;
      });
    };
    window.addEventListener("dbdock:cycle-database-tab", cycle);
    return () => window.removeEventListener("dbdock:cycle-database-tab", cycle);
  }, [sid, tabs, selectTab]);


  const selectSchema = useCallback((name: string) => {
    navigationEpoch.current++;
    setSchema(name);
    setFilter("");
  }, []);

  const openTable = (table: TableInfo, tableSchema = schema) => {
    navigationEpoch.current++;
    const existing = tabs.find((tab) => tab.type === "table" && tab.schema === tableSchema && tab.table === table.name);
    if (existing) { setActive(existing.id); return; }
    const tab: Tab = { id: newId(), type: "table", schema: tableSchema, table: table.name, isView: table.kind === "view" };
    setTabs((items) => [...items, tab]);
    setActive(tab.id);
  };

  const activeQueryId = tabs.find((tab) => tab.id === active && tab.type === "query")?.id;
  useEffect(() => {
    if (activeQueryId) lastQueryId.current = activeQueryId;
  }, [activeQueryId]);

  const activeTable = tabs.find((tab) => tab.id === active && tab.type === "table");
  useEffect(() => {
    if (visible && activeTable?.type === "table") {
      onVisit({ type: "table", connectionId, database, schema: activeTable.schema, table: activeTable.table });
    }
  }, [visible, activeTable, connectionId, database, onVisit]);

  const tableActions = useRef({ openTable, tableState, tabs, schemas, schemasStatus });
  tableActions.current = { openTable, tableState, tabs, schemas, schemasStatus };
  useEffect(() => {
    if (!navigationRequest) return;
    const { target } = navigationRequest;
    const epoch = ++navigationEpoch.current;
    const stillCurrent = () => epoch === navigationEpoch.current;
    const openTarget = async () => {
      const { tableState: state, tabs: openTabs, schemas: knownSchemas, schemasStatus: status } = tableActions.current;
      if (target.type === "schema") {
        const available = status === "ready" ? knownSchemas : await api.schemas(sid);
        if (!stillCurrent()) return;
        if (!available.includes(target.schema)) { toast("error", t("This schema is no longer available")); return; }
        selectSchema(target.schema);
        onVisit(target);
        return;
      }
      const existing = openTabs.find((tab) => tab.type === "table" && tab.schema === target.schema && tab.table === target.table);
      if (existing) {
        selectSchema(target.schema);
        setActive(existing.id);
        return;
      }
      const items = state.schema === target.schema && state.status === "ready" ? state.items : await api.tables(sid, target.schema);
      if (!stillCurrent()) return;
      const table = items.find(({ name }) => name === target.table);
      if (!table) {
        toast("error", t("This table is no longer available"));
        return;
      }
      selectSchema(target.schema);
      tableActions.current.openTable(table, target.schema);
    };
    void openTarget().catch((error) => { if (stillCurrent()) toast("error", errText(error)); });
    return () => { navigationEpoch.current++; };
  }, [navigationRequest, sid, selectSchema, onVisit, toast]);

  useEffect(() => {
    if (!isPostgres || !showQuick) return;
    let current = true;
    setDatabaseStatus({ loading: true, error: null });
    api.databases(sid).then((items) => {
      if (!current) return;
      setPostgresDatabases(items);
      setDatabaseStatus({ loading: false, error: null });
    }).catch((error) => {
      if (current) setDatabaseStatus({ loading: false, error: errText(error) });
    });
    return () => { current = false; };
  }, [isPostgres, showQuick, sid]);

  useEffect(() => {
    if (!showQuick) return;
    const databases = isPostgres ? postgresDatabases : isMysql ? schemas : [];
    const targets: NavigationTarget[] = [
      ...databases.map((name): NavigationTarget => ({ type: "database", connectionId, database: name })),
      ...(isMysql ? [] : schemas.map((name): NavigationTarget => ({ type: "schema", connectionId, database, schema: name }))),
      ...tables.map((item): NavigationTarget => ({ type: "table", connectionId, database, schema, table: item.name })),
    ];
    onCatalog({
      sessionId: sid, targets,
      loadingDatabases: isPostgres ? databaseStatus.loading : isMysql && schemasStatus === "loading",
      databaseError: isPostgres ? databaseStatus.error : isMysql ? schemaError : null,
    });
  }, [showQuick, isPostgres, postgresDatabases, isMysql, schemas, schema, tables, databaseStatus, schemasStatus, schemaError, onCatalog, connectionId, database, sid]);

  const newQuery = () => {
    navigationEpoch.current++;
    const n = tabs.filter((t) => t.type === "query").length + 1;
    const tab: Tab = { id: newId(), type: "query", title: `Query ${n}`, sql: "" };
    setTabs((ts) => [...ts, tab]);
    setActive(tab.id);
  };

  const focusSqlEditor = () => {
    const queryTabs = tabs.filter((tab) => tab.type === "query");
    const target = activeQueryId ?? queryTabs.find((tab) => tab.id === lastQueryId.current)?.id ?? queryTabs[0]?.id;
    if (!target) return;
    navigationEpoch.current++;
    selectTab(target);
  };

  const closeTab = async (id: string) => {
    const state = dirtyTabs.current.get(sid)?.get(id);
    if (state === "busy") { await message(t("Wait for the commit to finish before closing this tab."), { kind: "warning" }); return; }
    if (state === "dirty" && !(await ask(t("Discard uncommitted changes in this tab?"), { title: t("Discard changes"), kind: "warning", okLabel: t("Discard") }))) return;
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === active) setActive(next[Math.max(0, i - 1)]?.id ?? null);
      return next;
    });
  };

  useEffect(() => {
    const onAction = (event: Event) => {
      const { sessionId, action } = (event as CustomEvent<{ sessionId: string; action: string }>).detail;
      if (sessionId !== sid) return;
      if (action === "new-sql-tab") newQuery();
      else if (action === "focus-sql-editor") focusSqlEditor();
      else if (action === "close-database-tab" && tabs.length) {
        // Claim the shortcut before any asynchronous discard confirmation.
        event.preventDefault();
        void closeTab((tabs.find((tab) => tab.id === active) ?? tabs[0]).id);
      }
    };
    window.addEventListener("dbdock:database-action", onAction);
    return () => window.removeEventListener("dbdock:database-action", onAction);
  });

  const shown = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  const listStatus = tableListStatus(schema, schemasStatus, tableState.schema, tableState.status, tables.length, shown.length);
  const tableNameCounts = new Map<string, number>();
  for (const tab of tabs) {
    if (tab.type === "table") tableNameCounts.set(tab.table, (tableNameCounts.get(tab.table) ?? 0) + 1);
  }

  return (
    <div className="workspace sql-workspace">
      <aside className="sidebar">
        <select value={schema} onChange={(e) => {
          const name = e.target.value;
          if (isMysql) onNavigate({ type: "database", connectionId, database: name });
          else {
            selectSchema(name);
            onVisit({ type: "schema", connectionId, database, schema: name });
          }
        }} title={t(isMysql ? "Database" : "Schema")} aria-label={t(isMysql ? "Database" : "Schema")}>
          {!schema && <option value="" disabled>{isMysql ? t("Choose database") : ""}</option>}
          {!!schema && !schemas.includes(schema) && <option>{schema}</option>}
          {schemas.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div className="row">
          <input className="search" placeholder={t("Filter tables")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={() => { setSchemaReload((n) => n + 1); refreshTables(); }} title={t("Reload")}>
            <RefreshCw size={14} />
          </button>
        </div>
        {session.sqlProtection !== "browseOnly" && <button disabled={!schema || schemasStatus !== "ready"} onClick={() => setCreating(true)}>
          <Plus size={14} />{t("New table")}
        </button>}
        {schemaError && <div className="status bad">{schemaError}</div>}
        {tableError && <div className="status bad">{tableError}</div>}
        <ul className="list">
          {shown.map((table) => {
            const on = tabs.some((x) => x.id === active && x.type === "table" && x.schema === schema && x.table === table.name);
            return (
              <li key={table.name} className={`sql-object ${on ? "on" : ""}`}>
                <button type="button" className="link" aria-current={on ? "true" : undefined} onClick={() => openTable(table)} title={table.name}>
                  <span className={`icon ${table.kind}`} aria-hidden="true">{table.kind === "view" ? "◇" : "▦"}</span>
                  <span className="sql-object-name">{table.name}</span>
                </button>
              </li>
            );
          })}
          {listStatus === "loading" && <li className="muted loading-status" role="status"><span className="loading-spinner" aria-hidden="true" />{t("Loading tables…")}</li>}
          {listStatus === "no-schemas" && <li className="muted">{t(isMysql && schemas.length ? "Choose database" : "No schemas")}</li>}
          {listStatus === "no-tables" && <li className="muted">{t("No tables")}</li>}
          {listStatus === "no-matches" && <li className="muted">{t("No matching tables")}</li>}
        </ul>
      </aside>

      <section className="main">
        <div className={`sql-connection-context${env === "production" ? " production" : ""}`}>
          {env === "production" ? <ShieldAlert size={15} aria-hidden="true" /> : <Database size={15} aria-hidden="true" />}
          <EnvBadge env={env} />
          <strong title={connectionName}>{connectionName}</strong>
          {(isMysql || isPostgres) && database && <span className="sql-context-database" title={database}>{database}</span>}
          {session.sqlProtection !== "automatic" && <span className="sql-protection">
            <LockKeyhole size={13} aria-hidden="true" />
            {t(session.sqlProtection === "browseOnly" ? "Browse only" : "Confirm writes")}
          </span>}
        </div>
        <div className="tabs" role="group" aria-label={t("Workspace tabs")}>
          {tabs.map((tab, index) => {
            const fullName = tab.type === "table" ? `${tab.schema}.${tab.table}` : tab.title;
            const qualified = tab.type === "table" && (tableNameCounts.get(tab.table) ?? 0) > 1;
            return <div key={tab.id} className={`tab sql-workspace-tab ${tab.id === active ? "on" : ""}`}>
              <button type="button" className="link sql-tab-select" aria-label={fullName} aria-pressed={tab.id === active}
                title={fullName} onClick={() => { navigationEpoch.current++; selectTab(tab.id); }}>
                {qualified && <span className="sql-tab-schema" aria-hidden="true">{tab.schema}.</span>}
                <span className="sql-tab-name">{tab.type === "table" ? tab.table : tab.title}</span>
                {showTabNumbers && index < 9 && <kbd className="tab-number" aria-hidden="true">{index + 1}</kbd>}
              </button>
              <button
                type="button"
                className="x"
                aria-label={tf("Close tab {name}", { name: fullName })}
                onClick={() => void closeTab(tab.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>;
          })}
          <button className="tab-add" onClick={newQuery} title={`${t("New query")} (⌘T)`}>
            <FileCode size={14} />SQL
          </button>
        </div>
        <div className="tab-body">
          {tabs.map((t) => (
            <div key={t.id} className="tab-pane" hidden={t.id !== active}>
              {t.type === "table" ? (
                <TableView
                  sessionId={sid}
                  kind={session.kind}
                  schema={t.schema}
                  table={t.table}
                  isView={t.isView}
                  protection={session.sqlProtection}
                  connectionName={connectionName}
                  env={env}
                  dark={dark}
                  onSchemaChanged={() => refreshTables(t.schema)}
                  onReconnected={() => refreshCompletion(true)}
                  onDirtyChange={(dirty, busy) => {
                    const tabs = dirtyTabs.current.get(sid) ?? new Map<string, "dirty" | "busy">();
                    if (busy) tabs.set(t.id, "busy"); else if (dirty) tabs.set(t.id, "dirty"); else tabs.delete(t.id);
                    if (tabs.size) dirtyTabs.current.set(sid, tabs); else dirtyTabs.current.delete(sid);
                  }}
                />
              ) : (
                <QueryView
                  sessionId={sid}
                  kind={session.kind}
                  history={history.get(connectionId, database)}
                  visible={visible && t.id === active}
                  focusRequest={focusRequest}
                  protection={session.sqlProtection}
                  connectionName={connectionName}
                  database={database}
                  env={env}
                  onExecuted={(sql) => { history.add(connectionId, database, sql); setHistoryVersion((n) => n + 1); }}
                  value={t.sql}
                  onChange={(v) => setTabs((ts) => ts.map((x) => (x.id === t.id && x.type === "query" ? { ...x, sql: v } : x)))}
                  completionCatalog={completionCatalog}
                  completionRevision={completionRevision}
                  onCompletionChanged={refreshCompletion}
                  dark={dark}
                />
              )}
            </div>
          ))}
          {!tabs.length && <ResultEmpty
            illustrated
            title={t("No open tabs")}
            detail={t("Open a table from the sidebar to view data.")}
            action={session.sqlProtection !== "browseOnly" && (
              <button type="button" onClick={newQuery} title={`${t("New query")} (⌘T)`}>
                <FileCode size={14} aria-hidden="true" />{t("New query")}
              </button>
            )}
          />}
        </div>
        {creating && <SchemaEditor sessionId={sid} schema={schema} connectionName={connectionName} env={env} kind={session.kind} protection={session.sqlProtection}
          onClose={() => setCreating(false)}
          onBusy={(busy) => {
            const states = dirtyTabs.current.get(sid) ?? new Map<string, "dirty" | "busy">();
            if (busy) states.set("create-table", "busy");
            else states.delete("create-table");
            if (states.size) dirtyTabs.current.set(sid, states);
            else dirtyTabs.current.delete(sid);
          }}
          onApplied={(name) => {
            setCreating(false);
            setFilter("");
            refreshTables();
            openTable({ name, kind: "table" });
          }}
        />}
      </section>
    </div>
  );
}
