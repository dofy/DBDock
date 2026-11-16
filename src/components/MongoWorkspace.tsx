import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errText, type Doc, type SessionInfo } from "../api";
import { useToast } from "./Toast";
import { CodeEditor, vimExtension } from "./CodeEditor";
import { inEditor, useSettings } from "../settings";
import { Eraser, ListTree, Pencil, Plus, RefreshCw, Search, SquareTerminal, Trash2, X } from "lucide-react";

type Tab = { id: string; type: "coll"; coll: string } | { id: string; type: "shell" };

let seq = 0;
const newId = () => `m${++seq}`;

/** Compact display of one Extended JSON value in a table cell. */
function cellText(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$oid === "string") return `ObjectId("${o.$oid}")`;
    if (o.$date !== undefined) return typeof o.$date === "string" ? o.$date : JSON.stringify(o.$date);
    if (o.$numberDecimal !== undefined) return String(o.$numberDecimal);
    if (o.$numberLong !== undefined) return String(o.$numberLong);
    if (Array.isArray(v)) return `[${v.length}] ${JSON.stringify(v)}`;
    return JSON.stringify(v);
  }
  return String(v);
}

/** Union of top-level keys, `_id` first, in first-seen order. */
function columnsOf(docs: Doc[]): string[] {
  const seen = new Set<string>(["_id"]);
  for (const d of docs) for (const k of Object.keys(d)) seen.add(k);
  return [...seen].filter((k) => k !== "_id" || docs.some((d) => "_id" in d));
}

function DocTable({ docs, selected, onSelect, onOpen }: { docs: Doc[]; selected: number | null; onSelect: (i: number) => void; onOpen: (i: number) => void }) {
  const cols = useMemo(() => columnsOf(docs), [docs]);
  return (
    <div className="grid-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {docs.map((d, i) => (
            <tr key={i} className={selected === i ? "sel-row" : ""} onClick={() => onSelect(i)} onDoubleClick={() => onOpen(i)}>
              <td className="rownum">{i + 1}</td>
              {cols.map((c) => {
                const v = d[c];
                return (
                  <td key={c} className={v === undefined ? "null" : v === null ? "null" : typeof v === "number" ? "num" : ""} title={typeof v === "object" ? JSON.stringify(v, null, 2).slice(0, 800) : undefined}>
                    {v === undefined ? "—" : cellText(v).slice(0, 160)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!docs.length && <div className="grid-empty muted">No documents</div>}
    </div>
  );
}

function DocList({ docs, selected, onSelect, onOpen }: { docs: Doc[]; selected: number | null; onSelect: (i: number) => void; onOpen: (i: number) => void }) {
  return (
    <div className="doc-list">
      {docs.map((d, i) => (
        <pre key={i} className={`doc ${selected === i ? "on" : ""}`} onClick={() => onSelect(i)} onDoubleClick={() => onOpen(i)}>
          {JSON.stringify(d, null, 2)}
        </pre>
      ))}
      {!docs.length && <div className="grid-empty muted">No documents</div>}
    </div>
  );
}

function DocEditor({ initial, isNew, onSave, onDelete, onClose }: { initial: Doc; isNew: boolean; onSave: (d: Doc) => Promise<void>; onDelete?: () => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const save = async () => {
    let doc: Doc;
    try {
      doc = JSON.parse(text);
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("a document must be a JSON object");
    } catch (e) {
      return setError(`Invalid JSON: ${errText(e)}`);
    }
    setBusy(true);
    try {
      await onSave(doc);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{isNew ? "Insert document" : "Edit document"}</h2>
        <p className="muted small">Extended JSON: {`{"$oid": "…"}`} for ObjectId, {`{"$date": "2026-01-02T03:04:05Z"}`} for dates. ⌘S saves.</p>
        <div className="doc-editor">
          <CodeEditor value={text} onChange={setText} language="json" onSave={() => void save()} autoFocus />
        </div>
        {error && <div className="status bad">{error}</div>}
        <div className="actions">
          {onDelete && (
            <button className="danger" onClick={() => void onDelete()} disabled={busy}>
              <Trash2 size={14} />Delete
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {isNew ? "Insert" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CollectionView({ sessionId, db, coll }: { sessionId: string; db: string; coll: string }) {
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("");
  const [projection, setProjection] = useState("");
  const [applied, setApplied] = useState({ filter: "", sort: "", projection: "" });
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(0);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"table" | "json">("table");
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ doc: Doc; isNew: boolean } | null>(null);
  const [indexes, setIndexes] = useState<Doc[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const f = applied.filter || undefined;
      const [r, n] = await Promise.all([
        api.mongoFind({ sessionId, db, coll, filter: f, sort: applied.sort || undefined, projection: applied.projection || undefined, skip: page * limit, limit }),
        api.mongoCount(sessionId, db, coll, f).catch(() => null),
      ]);
      setDocs(r.docs);
      setHasMore(r.hasMore);
      setElapsed(r.elapsedMs);
      setCount(n);
      setSelected(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, db, coll, applied, page, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = () => {
    setPage(0);
    setApplied({ filter: filter.trim(), sort: sort.trim(), projection: projection.trim() });
  };

  const del = async (d: Doc) => {
    if (!(await ask(`Delete this document?\n\n_id: ${cellText(d._id)}`, { title: "Delete document", kind: "warning" }))) return;
    try {
      await api.mongoDelete(sessionId, db, coll, [d._id]);
      toast("ok", "Deleted 1 document");
      setEditing(null);
      await load();
    } catch (e) {
      toast("error", errText(e));
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label className="mongo-field">
      <span className="muted">{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} placeholder={placeholder} spellCheck={false} />
    </label>
  );

  const open = (i: number) => setEditing({ doc: docs[i], isNew: false });
  const sel = selected !== null ? docs[selected] : null;

  return (
    <div className="tableview">
      <div className="toolbar mongo-toolbar">
        {field("filter", filter, setFilter, "{ age: { $gt: 18 } }")}
        {field("sort", sort, setSort, "{ _id: -1 }")}
        {field("projection", projection, setProjection, "{ name: 1 }")}
        <button className="primary" onClick={apply}>
          <Search size={14} />Find
        </button>
      </div>
      <div className="toolbar">
        <div className="seg">
          <button className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}>
            Table
          </button>
          <button className={mode === "json" ? "on" : ""} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>
        <span className="spacer" />
        <button onClick={() => setEditing({ doc: {}, isNew: true })}><Plus size={14} />Insert</button>
        <button onClick={() => sel && open(selected!)} disabled={!sel}>
          <Pencil size={14} />Edit
        </button>
        <button className="danger" onClick={() => sel && void del(sel)} disabled={!sel}>
          <Trash2 size={14} />Delete
        </button>
        <button
          onClick={() =>
            api
              .mongoIndexes(sessionId, db, coll)
              .then(setIndexes)
              .catch((e) => toast("error", errText(e)))
          }
        >
          <ListTree size={14} />Indexes
        </button>
        <button onClick={() => void load()} disabled={loading} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>
      {error && <pre className="error">{error}</pre>}
      {mode === "table" ? <DocTable docs={docs} selected={selected} onSelect={setSelected} onOpen={open} /> : <DocList docs={docs} selected={selected} onSelect={setSelected} onOpen={open} />}
      <div className="statusbar">
        <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
          ‹
        </button>
        <span>
          {docs.length ? page * limit + 1 : 0}–{page * limit + docs.length}
          {count !== null && ` of ${count}`}
        </span>
        <button disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          ›
        </button>
        <select
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            setPage(0);
          }}
        >
          {[20, 50, 200, 1000].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <span className="muted">double-click a document to edit</span>
        <span className="spacer" />
        {elapsed !== null && <span className="muted">{elapsed} ms</span>}
      </div>

      {editing && (
        <DocEditor
          initial={editing.doc}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onDelete={editing.isNew ? undefined : () => del(editing.doc)}
          onSave={async (d) => {
            if (editing.isNew) {
              await api.mongoInsert(sessionId, db, coll, d);
              toast("ok", "Inserted 1 document");
            } else {
              await api.mongoReplace(sessionId, db, coll, editing.doc._id, d);
              toast("ok", "Saved");
            }
            setEditing(null);
            await load();
          }}
        />
      )}
      {indexes && (
        <div className="modal-backdrop" onMouseDown={() => setIndexes(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Indexes · {coll}</h2>
            <pre className="sql-preview">{JSON.stringify(indexes, null, 2)}</pre>
            <div className="actions">
              <span className="spacer" />
              <button onClick={() => setIndexes(null)}><X size={14} />Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ShellEntry {
  db: string;
  line: string;
  docs?: Doc[];
  value?: unknown;
  error?: string;
  ms?: number;
}

function ShellView({ sessionId, db, onUse, dark }: { sessionId: string; db: string; onUse: (db: string) => void; dark: boolean }) {
  const [text, setText] = useState("");
  const [out, setOut] = useState<ShellEntry[]>([]);
  const [running, setRunning] = useState(false);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [out]);

  const run = async () => {
    const view = ref.current?.view;
    let line = text;
    if (view) {
      const { from, to } = view.state.selection.main;
      line = from !== to ? view.state.sliceDoc(from, to) : view.state.doc.lineAt(from).text.trim() || text;
    }
    line = line.trim();
    if (!line || running) return;
    setRunning(true);
    try {
      const r = await api.mongoShell(sessionId, db, line);
      setOut((o) => [...o, { db, line, docs: r.kind === "docs" ? r.docs : undefined, value: r.kind === "value" ? r.value : undefined, ms: r.elapsedMs }]);
      if (r.db) onUse(r.db);
    } catch (e) {
      setOut((o) => [...o, { db, line, error: errText(e) }]);
    } finally {
      setRunning(false);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  const { vim: vimOn } = useSettings();
  const extensions = useMemo(
    () => [
      ...(vimOn ? [vimExtension(() => void runRef.current())] : []),
      javascript(),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              void runRef.current();
              return true;
            },
          },
        ]),
      ),
    ],
    [vimOn],
  );

  return (
    <div className="query">
      <div className="editor mongo-editor">
        <CodeMirror
          ref={ref}
          value={text}
          onChange={setText}
          extensions={extensions}
          theme={dark ? "dark" : "light"}
          height="100%"
          placeholder={'db.users.find({ age: { $gt: 18 } }).sort({ _id: -1 }).limit(20)\ndb.users.aggregate([{ $group: { _id: "$city", n: { $sum: 1 } } }])\nshow collections · use otherdb · db.runCommand({ dbStats: 1 })'}
          basicSetup={{ foldGutter: false }}
        />
      </div>
      <div className="toolbar">
        <button className="primary" onClick={() => void run()} disabled={running}>
          {running ? "Running…" : "Run"}
        </button>
        <span className="muted">⌘↵ runs the current line or selection · db = {db}</span>
        <span className="spacer" />
        <button onClick={() => setOut([])} disabled={!out.length}>
          <Eraser size={14} />Clear
        </button>
      </div>
      <div className="results shell-out">
        {out.map((e, i) => (
          <div key={i} className="shell-entry">
            <div className="prompt">
              {e.db}&gt; {e.line}
              {e.ms !== undefined && <span className="muted"> · {e.ms} ms</span>}
            </div>
            {e.error ? (
              <pre className="error">{e.error}</pre>
            ) : e.docs ? (
              <pre className="value">{e.docs.length ? e.docs.map((d) => JSON.stringify(d, null, 2)).join("\n") : "(no documents)"}</pre>
            ) : (
              <pre className="value">{JSON.stringify(e.value, null, 2)}</pre>
            )}
          </div>
        ))}
        {!out.length && <div className="grid-empty muted">Results appear here.</div>}
        <div ref={endRef} />
      </div>
    </div>
  );
}

export function MongoWorkspace({ session, dark }: { session: SessionInfo; dark: boolean }) {
  const sid = session.sessionId;
  const toast = useToast();
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState(session.defaultSchema || "admin");
  const [colls, setColls] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([{ id: newId(), type: "shell" }]);
  const [active, setActive] = useState(tabs[0].id);

  useEffect(() => {
    api
      .mongoDatabases(sid)
      .then(setDbs)
      .catch((e) => toast("error", errText(e)));
  }, [sid, toast]);

  const loadColls = useCallback(() => {
    api
      .mongoCollections(sid, db)
      .then(setColls)
      .catch((e) => {
        setColls([]);
        toast("error", errText(e));
      });
  }, [sid, db, toast]);
  useEffect(() => {
    loadColls();
  }, [loadColls]);

  // Collection tabs belong to one database; switching db closes them.
  const switchDb = (d: string) => {
    setDb(d);
    setTabs((ts) => {
      const kept = ts.filter((t) => t.type === "shell");
      if (!kept.some((t) => t.id === active)) setActive(kept[0]?.id ?? "");
      return kept;
    });
    if (!dbs.includes(d)) setDbs((x) => [...x, d].sort());
  };

  const openColl = (coll: string) => {
    const existing = tabs.find((t) => t.type === "coll" && t.coll === coll);
    if (existing) return setActive(existing.id);
    const t: Tab = { id: newId(), type: "coll", coll };
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  };

  const closeTab = (id: string) =>
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === active && next.length) setActive(next[Math.max(0, i - 1)].id);
      return next;
    });

  const shown = colls.filter((c) => c.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="workspace">
      <aside className="sidebar">
        <select value={db} onChange={(e) => switchDb(e.target.value)} title="Database">
          {[...new Set([db, ...dbs])].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <div className="row">
          <input className="search" placeholder="Filter collections" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={loadColls} title="Reload">
            <RefreshCw size={14} />
          </button>
        </div>
        <ul className="list">
          {shown.map((c) => {
            const on = tabs.some((t) => t.id === active && t.type === "coll" && t.coll === c);
            return (
              <li key={c} className={on ? "on" : ""} onClick={() => openColl(c)} title={c}>
                <span className="icon">▤</span>
                {c}
              </li>
            );
          })}
          {!shown.length && <li className="muted">No collections</li>}
        </ul>
      </aside>
      <section className="main">
        <div className="tabs">
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active ? "on" : ""}`} onClick={() => setActive(t.id)}>
              <span>{t.type === "coll" ? t.coll : "Shell"}</span>
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
          <button
            className="tab-add"
            onClick={() => {
              const t: Tab = { id: newId(), type: "shell" };
              setTabs((ts) => [...ts, t]);
              setActive(t.id);
            }}
          >
            <SquareTerminal size={14} />Shell
          </button>
        </div>
        <div className="tab-body">
          {tabs.map((t) => (
            <div key={t.id} className="tab-pane" hidden={t.id !== active}>
              {t.type === "coll" ? <CollectionView sessionId={sid} db={db} coll={t.coll} /> : <ShellView sessionId={sid} db={db} onUse={switchDb} dark={dark} />}
            </div>
          ))}
          {!tabs.length && <div className="grid-empty muted">Pick a collection, or open a shell.</div>}
        </div>
      </section>
    </div>
  );
}
