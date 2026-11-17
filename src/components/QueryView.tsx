import { t, tf } from "../i18n";
import { FileDown, FileUp, Play, Square } from "lucide-react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { selectedOrCurrentLine } from "../sqlHistory";
import { useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { api, errText, type Kind, type QueryResult } from "../api";
import { DataGrid } from "./DataGrid";
import { sqlExtensions } from "../sqlComplete";
import { useSettings } from "../settings";
import { vimExtension } from "./CodeEditor";

interface Props {
  sessionId: string;
  kind: Kind;
  history: string[];
  onExecuted: (sql: string) => void;
  value: string;
  onChange: (v: string) => void;
  /** table name -> columns, for autocomplete */
  schema: Record<string, string[]>;
  dark: boolean;
}

export function QueryView({ sessionId, kind, history, onExecuted, value, onChange, schema, dark }: Props) {
  const [results, setResults] = useState<QueryResult[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const ref = useRef<ReactCodeMirrorRef>(null);

  const run = async (all = false) => {
    const view = ref.current?.view;
    const doc = view?.state.doc.toString() ?? value;
    const selection = view?.state.selection.main;
    const text = all ? doc : selectedOrCurrentLine(doc, selection?.from ?? 0, selection?.to ?? 0);
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    onExecuted(text);
    const t0 = performance.now();
    try {
      const r = await api.execute(sessionId, text);
      setResults(r);
      // Show the last result that has rows, like most clients.
      const idx = r.map((x) => x.columns.length > 0).lastIndexOf(true);
      setActive(idx >= 0 ? idx : Math.max(0, r.length - 1));
    } catch (e) {
      setError(errText(e));
      setResults([]);
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setRunning(false);
    }
  };
  const saveFile = async () => {
    try {
      const path = await save({ defaultPath: "query.sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (path) await api.writeSqlFile(path, ref.current?.view?.state.doc.toString() ?? value);
    } catch (e) { setError(errText(e)); }
  };
  const loadFile = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "SQL", extensions: ["sql"] }, { name: "All", extensions: ["*"] }] });
      if (!path || typeof path !== "string") return;
      const text = await api.readSqlFile(path);
      const current = ref.current?.view?.state.doc.toString() ?? value;
      if (current.trim() && text !== current && !(await ask(t("Replace the current SQL text?"), { title: t("Load SQL"), kind: "warning" }))) return;
      onChange(text);
    } catch (e) { setError(errText(e)); }
  };
  const chooseHistory = async (index: number) => {
    const text = history[index];
    if (text === undefined || text === value) return;
    if (value.trim() && !(await ask(t("Replace the current SQL text?"), { title: t("Recent SQL"), kind: "warning" }))) return;
    onChange(text);
  };
  const cancel = () => {
    api.cancel(sessionId).catch((e) => setError(errText(e)));
  };
  const saveRef = useRef(saveFile);
  saveRef.current = saveFile;
  const runRef = useRef(run);
  runRef.current = run;

  const { vim: vimOn } = useSettings();
  const extensions = useMemo(
    () => [
      // Vim first; `:w` runs the query.
      ...(vimOn ? [vimExtension(() => void runRef.current())] : []),
      ...sqlExtensions(kind, schema),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => { void saveRef.current(); return true; },
          },
          {
            key: "Mod-Shift-Enter",
            run: () => { void runRef.current(true); return true; },
          },
          {
            key: "Mod-Enter",
            run: () => {
              void runRef.current(false);
              return true;
            },
          },
        ]),
      ),
    ],
    [kind, schema, vimOn],
  );

  const cur = results[active];

  return (
    <div className="query">
      <div className="editor">
        <CodeMirror ref={ref} value={value} onChange={onChange} extensions={extensions} theme={dark ? "dark" : "light"} height="100%" basicSetup={{ foldGutter: false }} />
      </div>
      <div className="toolbar">
        {running ? (
          <button className="danger" onClick={cancel} disabled={kind === "sqlite" || kind === "d1"} title={kind === "sqlite" || kind === "d1" ? t("This database cannot cancel a running query") : t("Cancel the running query")}>
            <Square size={13} />
             {t("Cancel")} </button>
        ) : (
          <button className="primary" onClick={() => void run(false)}>
            <Play size={13} />
             {t("Run")} </button>
        )}
        <button onClick={() => void run(true)} disabled={running} title={t("Run all SQL (⇧⌘↵)")}>{t("Run all")}</button>
        <button onClick={() => void saveFile()} title={t("Save SQL to file")} aria-label={t("Save SQL to file")}><FileDown size={14} /></button>
        <button onClick={() => void loadFile()} title={t("Load SQL from file")} aria-label={t("Load SQL from file")}><FileUp size={14} /></button>
        <select value="" aria-label={t("Recent SQL")} title={t("Recent SQL (this app session)")} disabled={!history.length} onChange={(e) => { if (e.target.value) void chooseHistory(Number(e.target.value) - 1); }}>
          <option value="">{t("Recent SQL")}</option>
          {history.map((sql, i) => <option key={sql} value={i + 1}>{sql.replace(/\s+/g, " ").slice(0, 100)}</option>)}
        </select>
        {vimOn && <span className="vim-badge static">VIM</span>}
        <span className="muted query-hint">{running ? t("Running…") : `${t("⌘↵ runs the current line or selection · ⇧⌘↵ runs all")}${vimOn ? t(" · :w runs") : ""}`}</span>
        <span className="spacer" />
        {results.length > 1 &&
          results.map((r, i) => (
            <button key={i} className={`chip ${i === active ? "on" : ""}`} onClick={() => setActive(i)}>
              {r.columns.length ? tf("Result {number}", { number: i + 1 }) : `#${i + 1} (${r.rowsAffected ?? 0})`}
            </button>
          ))}
        {elapsed != null && <span className="muted">{elapsed} ms</span>}
      </div>
      <div className="results">
        {error ? (
          <pre className="error">{error}</pre>
        ) : cur ? (
          <>
            <DataGrid result={cur} />
            <div className="statusbar">
              {cur.columns.length ? tf("{count} row(s)", { count: cur.rows.length }) : tf("{count} row(s) affected", { count: cur.rowsAffected ?? 0 })}
              {cur.truncated && t(" · truncated to 5000 rows")}
            </div>
          </>
        ) : (
          <div className="grid-empty muted">{t("Results appear here.")}</div>
        )}
      </div>
    </div>
  );
}
