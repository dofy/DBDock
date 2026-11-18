import { t, tf } from "../i18n";
import { ChevronDown, FileDown, FileUp, Play, Square } from "lucide-react";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { selectedOrCurrentLine } from "../sqlHistory";
import { useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { api, errText, type Kind, type QueryResult, type SqlProtection } from "../api";
import { DataGrid } from "./DataGrid";
import { sqlExtensions } from "../sqlComplete";
import { useSettings } from "../settings";
import { vimExtension } from "./CodeEditor";
import { serializeResult, type ExportFormat } from "../sqlResultExport";
import { confirmSqlWrite } from "../sqlWriteConfirmation";

interface Props {
  sessionId: string;
  protection: SqlProtection;
  connectionName: string;
  database: string;
  env: string;
  kind: Kind;
  history: string[];
  onExecuted: (sql: string) => void;
  value: string;
  onChange: (v: string) => void;
  /** table name -> columns, for autocomplete */
  schema: Record<string, string[]>;
  dark: boolean;
}

export function QueryView({ sessionId, protection, connectionName, database, env, kind, history, onExecuted, value, onChange, schema, dark }: Props) {
  const [results, setResults] = useState<QueryResult[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [exporting, setExporting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [showRunOptions, setShowRunOptions] = useState(false);
  const executing = useRef(false);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const runOptionsButton = useRef<HTMLButtonElement>(null);
  const runAllButton = useRef<HTMLButtonElement>(null);

  const run = async (all = false) => {
    const view = ref.current?.view;
    const doc = view?.state.doc.toString() ?? value;
    const selection = view?.state.selection.main;
    const text = all ? doc : selectedOrCurrentLine(doc, selection?.from ?? 0, selection?.to ?? 0);
    setShowRunOptions(false);
    if (!text.trim() || executing.current || protection === "browseOnly") return;
    executing.current = true;
    let t0: number | undefined;
    try {
      const confirmed = protection === "confirm" && await api.sqlNeedsConfirmation(sessionId, text);
      if (confirmed && !(await confirmSqlWrite({
        connectionName, env, object: database, sql: text,
        title: t("Confirm SQL execution"), action: t("Run"),
        summary: t(all ? "Run all SQL (⇧⌘↵)" : selection?.empty === false ? "Run selected SQL" : "Run SQL on the current line"),
      }))) return;
      setRunning(true);
      setError(null);
      onExecuted(text);
      t0 = performance.now();
      const r = await api.execute(sessionId, text, confirmed);
      setResults(r);
      // Show the last result that has rows, like most clients.
      const idx = r.map((x) => x.columns.length > 0).lastIndexOf(true);
      setActive(idx >= 0 ? idx : Math.max(0, r.length - 1));
    } catch (e) {
      setError(errText(e));
      setResults([]);
    } finally {
      executing.current = false;
      if (t0 !== undefined) setElapsed(Math.round(performance.now() - t0));
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
  const runScope = t(hasSelection ? "Run selected SQL" : "Run SQL on the current line");
  const exportResult = async () => {
    if (!cur?.columns.length || exporting) return;
    setExporting(true);
    try {
      const path = await save({ defaultPath: `result-${active + 1}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (path) await api.writeSqlFile(path, serializeResult(cur, format));
    } catch (e) {
      // Preserve the result when the save is unsuccessful.
      await message(errText(e), { kind: "error", title: t("Export result") });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="query">
      <div className="editor">
        <CodeMirror ref={ref} value={value} onChange={onChange} onUpdate={(update) => {
          if (update.selectionSet || update.docChanged) setHasSelection(!update.state.selection.main.empty);
        }} extensions={extensions} theme={dark ? "dark" : "light"} height="100%" basicSetup={{ foldGutter: false }} />
      </div>
      <div className="toolbar query-toolbar">
        {running ? (
          <button className="danger" onClick={cancel} disabled={kind === "sqlite" || kind === "d1"} title={kind === "sqlite" || kind === "d1" ? t("This database cannot cancel a running query") : t("Cancel the running query")}>
            <Square size={13} />
             {t("Cancel")} </button>
        ) : (
          <div className="query-run" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setShowRunOptions(false);
          }} onKeyDown={(event) => {
            if (event.key === "Escape" && showRunOptions) {
              event.stopPropagation();
              runOptionsButton.current?.focus();
              setShowRunOptions(false);
            }
          }}>
            <button className="primary" title={`${runScope} (⌘↵)`} aria-label={`${t("Run")} · ${runScope}`} disabled={protection === "browseOnly"} onClick={() => void run(false)}>
              <Play size={13} />{t("Run")}
            </button>
            <button ref={runOptionsButton} className="primary query-run-toggle" aria-label={t("Run options")} aria-expanded={showRunOptions}
              disabled={protection === "browseOnly"} onClick={(event) => {
                event.currentTarget.focus();
                setShowRunOptions(!showRunOptions);
              }} onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                if (showRunOptions) runAllButton.current?.focus();
                else setShowRunOptions(true);
              }}>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {showRunOptions && <div className="query-run-options">
              <button ref={runAllButton} autoFocus title={t("Run all SQL (⇧⌘↵)")} onClick={() => {
                runOptionsButton.current?.focus();
                void run(true);
              }}><span>{t("Run all")}</span><kbd>⇧⌘↵</kbd></button>
            </div>}
          </div>
        )}
        <div className="workspace-tools" role="group" aria-label={t("SQL files and history")}>
          <button onClick={() => void saveFile()} title={t("Save SQL to file")} aria-label={t("Save SQL to file")}><FileDown size={14} /></button>
          <button onClick={() => void loadFile()} title={t("Load SQL from file")} aria-label={t("Load SQL from file")}><FileUp size={14} /></button>
          <select value="" aria-label={t("Recent SQL")} title={t("Recent SQL (this app session)")} disabled={!history.length} onChange={(e) => { if (e.target.value) void chooseHistory(Number(e.target.value) - 1); }}>
            <option value="">{t("Recent SQL")}</option>
            {history.map((sql, i) => <option key={sql} value={i + 1}>{sql.replace(/\s+/g, " ").slice(0, 100)}</option>)}
          </select>
        </div>
        {vimOn && <span className="vim-badge static">VIM</span>}
        {protection !== "browseOnly" && <span className="muted query-hint" title={runScope}>
          {running ? t("Running…") : `${runScope} · ⌘↵${vimOn ? t(" · :w runs") : ""}`}
        </span>}
      </div>
      <div className="results">
        {!error && results.length > 1 && <div className="toolbar query-result-tabs" role="group" aria-label={t("Query results")}>
          {results.map((r, i) => (
            <button key={i} className={`chip ${i === active ? "on" : ""}`} aria-pressed={i === active} onClick={() => setActive(i)}>
              {r.columns.length ? tf("Result {number}", { number: i + 1 }) : `#${i + 1} (${r.rowsAffected ?? 0})`}
            </button>
          ))}
        </div>}
        {error ? (
          <pre className="error">{error}</pre>
        ) : cur ? (
          <>
            <DataGrid result={cur} />
            <div className="statusbar query-result-status">
              <span>{cur.columns.length ? tf("{count} row(s)", { count: cur.rows.length }) : tf("{count} row(s) affected", { count: cur.rowsAffected ?? 0 })}
                {cur.truncated && t(" · truncated to 5000 rows")}
              </span>
              {elapsed != null && <span className="muted">{elapsed} ms</span>}
              {cur.columns.length > 0 && <div className="export-result">
                <select aria-label={t("Export format")} disabled={exporting} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                </select>
                <button disabled={running || exporting} title={t("Export the displayed result")} onClick={() => void exportResult()}>
                  <FileDown size={14} />{t("Export result")}
                </button>
              </div>}
            </div>
          </>
        ) : (
          <div className="grid-empty muted">{t("Results appear here.")}</div>
        )}
      </div>
    </div>
  );
}
