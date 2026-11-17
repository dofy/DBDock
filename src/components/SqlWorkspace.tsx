import { t } from "../i18n";
import { tableListStatus } from "../tableListStatus";
import { SqlHistory } from "../sqlHistory";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText, type SessionInfo, type TableInfo } from "../api";
import { TableView } from "./TableView";
import { QueryView } from "./QueryView";
import { FileCode, RefreshCw, X } from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";

type Tab =
  | { id: string; type: "table"; schema: string; table: string }
  | { id: string; type: "query"; title: string; sql: string };

interface Props {
  session: SessionInfo;
  connectionId: string;
  history: SqlHistory;
  showTabNumbers: boolean;
  dark: boolean;
  dirtyTabs: React.MutableRefObject<Map<string, Map<string, "dirty" | "busy">>>;
}

let seq = 0;
const newId = () => `t${++seq}`;

export function SqlWorkspace({ session, connectionId, history, showTabNumbers, dark, dirtyTabs }: Props) {
  const sid = session.sessionId;
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState(session.defaultSchema || "");
  const [tableState, setTableState] = useState<{ schema: string; status: "loading" | "ready" | "error"; items: TableInfo[]; error?: string }>({ schema: "", status: "loading", items: [] });
  const [schemasStatus, setSchemasStatus] = useState<"loading" | "ready" | "error">("loading");
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaReload, setSchemaReload] = useState(0);
  const tableRequest = useRef(0);
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([{ id: newId(), type: "query", title: "Query 1", sql: "" }]);
  const [active, setActive] = useState(tabs[0].id);
  const [columns, setColumns] = useState<Record<string, string[]>>({});
  const [, setHistoryVersion] = useState(0);

  useEffect(() => {
    let current = true;
    setSchemasStatus("loading");
    setSchemaError(null);
    api.schemas(sid).then((s) => {
      if (!current) return;
      setSchemas(s);
      setSchema((cur) => cur || s[0] || "");
      setSchemasStatus("ready");
    }).catch((e) => {
      if (!current) return;
      setSchemaError(errText(e));
      setSchemasStatus("error");
    });
    return () => { current = false; };
  }, [sid, schemaReload]);

  const loadTables = useCallback(() => {
    if (!schema) return;
    const request = ++tableRequest.current;
    setTableState({ schema, status: "loading", items: [] });
    setColumns({});
    api.tables(sid, schema).then((items) => {
      if (request === tableRequest.current) setTableState({ schema, status: "ready", items });
    }).catch((e) => {
      if (request === tableRequest.current) setTableState({ schema, status: "error", items: [], error: errText(e) });
    });
    // Completion metadata is independent of the table list.
    api.columns(sid, schema).then((items) => {
      if (request === tableRequest.current) setColumns(items);
    }).catch(() => {
      if (request === tableRequest.current) setColumns({});
    });
  }, [sid, schema]);

  useEffect(() => {
    loadTables();
    return () => { tableRequest.current++; };
  }, [loadTables]);

  const tables = tableState.schema === schema ? tableState.items : [];
  const tableError = tableState.schema === schema && tableState.status === "error" ? tableState.error : null;

  useEffect(() => {
    const cycle = (event: Event) => {
      const { sessionId, direction, index } = (event as CustomEvent<{ sessionId: string; direction?: number; index?: number }>).detail;
      if (sessionId !== sid || !tabs.length) return;
      if (index !== undefined) {
        if (index >= 0 && index < tabs.length) setActive(tabs[index].id);
        return;
      }
      setActive((current) => {
        const currentIndex = tabs.findIndex((tab) => tab.id === current);
        return tabs[(currentIndex + (direction ?? 1) + tabs.length) % tabs.length].id;
      });
    };
    window.addEventListener("dbdock:cycle-database-tab", cycle);
    return () => window.removeEventListener("dbdock:cycle-database-tab", cycle);
  }, [sid, tabs]);

  const completion = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t.name] = columns[t.name] ?? [];
    return out;
  }, [tables, columns]);

  const openTable = (t: TableInfo) => {
    const existing = tabs.find((x) => x.type === "table" && x.schema === schema && x.table === t.name);
    if (existing) return setActive(existing.id);
    const tab: Tab = { id: newId(), type: "table", schema, table: t.name };
    setTabs((ts) => [...ts, tab]);
    setActive(tab.id);
  };

  const newQuery = () => {
    const n = tabs.filter((t) => t.type === "query").length + 1;
    const tab: Tab = { id: newId(), type: "query", title: `Query ${n}`, sql: "" };
    setTabs((ts) => [...ts, tab]);
    setActive(tab.id);
  };

  const closeTab = async (id: string) => {
    const state = dirtyTabs.current.get(sid)?.get(id);
    if (state === "busy") { await message(t("Wait for the commit to finish before closing this tab.")); return; }
    if (state === "dirty" && !(await ask(t("Discard uncommitted changes in this tab?"), { title: t("Discard changes"), kind: "warning" }))) return;
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === active && next.length) setActive(next[Math.max(0, i - 1)].id);
      return next;
    });
  };

  useEffect(() => {
    const onAction = (event: Event) => {
      const { sessionId, action } = (event as CustomEvent<{ sessionId: string; action: string }>).detail;
      if (sessionId !== sid) return;
      if (action === "new-sql-tab") newQuery();
      else if (action === "close-database-tab" && active) void closeTab(active);
    };
    window.addEventListener("dbdock:database-action", onAction);
    return () => window.removeEventListener("dbdock:database-action", onAction);
  });

  const shown = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  const listStatus = tableListStatus(schema, schemasStatus, tableState.schema, tableState.status, tables.length, shown.length);

  return (
    <div className="workspace">
      <aside className="sidebar">
        <select value={schema} onChange={(e) => { tableRequest.current++; setSchema(e.target.value); }} title={session.kind === "mysql" ? t("Database") : t("Schema")}>
          {schemas.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div className="row">
          <input className="search" placeholder={t("Filter tables")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={() => { if (schemaError || !schema) setSchemaReload((n) => n + 1); else loadTables(); }} title={t("Reload")}>
            <RefreshCw size={14} />
          </button>
        </div>
        {schemaError && <div className="status bad">{schemaError}</div>}
        {tableError && <div className="status bad">{tableError}</div>}
        <ul className="list">
          {shown.map((t) => {
            const on = tabs.some((x) => x.id === active && x.type === "table" && x.schema === schema && x.table === t.name);
            return (
              <li key={t.name} className={on ? "on" : ""} onClick={() => openTable(t)} title={t.name}>
                <span className={`icon ${t.kind}`}>{t.kind === "view" ? "◇" : "▦"}</span>
                {t.name}
              </li>
            );
          })}
          {listStatus === "loading" && <li className="muted loading-status" role="status"><span className="loading-spinner" aria-hidden="true" />{t("Loading tables…")}</li>}
          {listStatus === "no-schemas" && <li className="muted">{t("No schemas")}</li>}
          {listStatus === "no-tables" && <li className="muted">{t("No tables")}</li>}
          {listStatus === "no-matches" && <li className="muted">{t("No matching tables")}</li>}
        </ul>
      </aside>

      <section className="main">
        <div className="tabs">
          {tabs.map((t, index) => (
            <div key={t.id} className={`tab ${t.id === active ? "on" : ""}`} onClick={() => setActive(t.id)}>
              <span>{t.type === "table" ? `${t.table}` : t.title}</span>
              {showTabNumbers && index < 9 && <kbd className="tab-number" aria-hidden="true">{index + 1}</kbd>}
              <button
                className="x"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(t.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
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
                  isView={tables.find((x) => x.name === t.table)?.kind === "view"}
                  dark={dark}
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
                  history={history.get(connectionId, schema)}
                  onExecuted={(sql) => { history.add(connectionId, schema, sql); setHistoryVersion((n) => n + 1); }}
                  value={t.sql}
                  onChange={(v) => setTabs((ts) => ts.map((x) => (x.id === t.id && x.type === "query" ? { ...x, sql: v } : x)))}
                  schema={completion}
                  dark={dark}
                />
              )}
            </div>
          ))}
          {!tabs.length && <div className="grid-empty muted">{t("Pick a table, or open a new SQL tab.")}</div>}
        </div>
      </section>
    </div>
  );
}
