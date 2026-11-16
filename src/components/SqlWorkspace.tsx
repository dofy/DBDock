import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errText, type SessionInfo, type TableInfo } from "../api";
import { TableView } from "./TableView";
import { QueryView } from "./QueryView";
import { FileCode, RefreshCw, X } from "lucide-react";

type Tab =
  | { id: string; type: "table"; schema: string; table: string }
  | { id: string; type: "query"; title: string; sql: string };

interface Props {
  session: SessionInfo;
  dark: boolean;
}

let seq = 0;
const newId = () => `t${++seq}`;

export function SqlWorkspace({ session, dark }: Props) {
  const sid = session.sessionId;
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState(session.defaultSchema || "");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ id: newId(), type: "query", title: "Query 1", sql: "" }]);
  const [active, setActive] = useState(tabs[0].id);
  const [columns, setColumns] = useState<Record<string, string[]>>({});

  useEffect(() => {
    api
      .schemas(sid)
      .then((s) => {
        setSchemas(s);
        setSchema((cur) => cur || s[0] || "");
      })
      .catch((e) => setError(errText(e)));
  }, [sid]);

  const loadTables = useCallback(() => {
    if (!schema) return;
    setError(null);
    api
      .tables(sid, schema)
      .then(setTables)
      .catch((e) => setError(errText(e)));
    // One query for every column in the schema, for autocomplete.
    api
      .columns(sid, schema)
      .then(setColumns)
      .catch(() => setColumns({}));
  }, [sid, schema]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

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

  const closeTab = (id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === active && next.length) setActive(next[Math.max(0, i - 1)].id);
      return next;
    });
  };

  const shown = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="workspace">
      <aside className="sidebar">
        <select value={schema} onChange={(e) => setSchema(e.target.value)} title={session.kind === "mysql" ? "Database" : "Schema"}>
          {schemas.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div className="row">
          <input className="search" placeholder="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={loadTables} title="Reload">
            <RefreshCw size={14} />
          </button>
        </div>
        {error && <div className="status bad">{error}</div>}
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
          {!shown.length && <li className="muted">No tables</li>}
        </ul>
      </aside>

      <section className="main">
        <div className="tabs">
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active ? "on" : ""}`} onClick={() => setActive(t.id)}>
              <span>{t.type === "table" ? `${t.table}` : t.title}</span>
              <button
                className="x"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="tab-add" onClick={newQuery} title="New query">
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
                />
              ) : (
                <QueryView
                  sessionId={sid}
                  kind={session.kind}
                  value={t.sql}
                  onChange={(v) => setTabs((ts) => ts.map((x) => (x.id === t.id && x.type === "query" ? { ...x, sql: v } : x)))}
                  schema={completion}
                  dark={dark}
                />
              )}
            </div>
          ))}
          {!tabs.length && <div className="grid-empty muted">Pick a table, or open a new SQL tab.</div>}
        </div>
      </section>
    </div>
  );
}
