import { t, tf } from "../i18n";
import { ChevronDown, FileDown, FileUp, History, Play, Square } from "lucide-react";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { selectedOrCurrentStatement } from "../sqlStatement";
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
import { CommandPalette } from "./CommandPalette";
import { useToast } from "./Toast";

interface Props {
  sessionId: string;
  protection: SqlProtection;
  connectionName: string;
  database: string;
  env: string;
  kind: Kind;
  history: string[];
  visible: boolean;
  onExecuted: (sql: string) => void;
  value: string;
  onChange: (v: string) => void;
  /** table name -> columns, for autocomplete */
  schema: Record<string, string[]>;
  dark: boolean;
}

export function QueryView({ sessionId, protection, connectionName, database, env, kind, history, visible, onExecuted, value, onChange, schema, dark }: Props) {
  const [results, setResults] = useState<QueryResult[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [exporting, setExporting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [showRunOptions, setShowRunOptions] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const executing = useRef(false);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const runOptionsButton = useRef<HTMLButtonElement>(null);
  const runAllButton = useRef<HTMLButtonElement>(null);

  const run = async (all = false) => {
    const view = ref.current?.view;
    const doc = view?.state.doc.toString() ?? value;
    const selection = view?.state.selection.main;
    setShowRunOptions(false);
    if (executing.current || protection === "browseOnly") return;
    const current = all ? { status: "sql" as const, text: doc } : selectedOrCurrentStatement(doc, selection?.from ?? 0, selection?.to ?? 0, kind);
    if (current.status === "ambiguous") {
      toast("info", t("Select the SQL you want to run, or use Run all"));
      return;
    }
    if (current.status !== "sql" || !current.text.trim()) return;
    const { text } = current;
    executing.current = true;
    let t0: number | undefined;
    try {
      const confirmed = protection === "confirm" && await api.sqlNeedsConfirmation(sessionId, text);
      if (confirmed && !(await confirmSqlWrite({
        connectionName, env, object: database, sql: text,
        title: t("Confirm SQL execution"), action: t("Run"),
        summary: t(all ? "Run all SQL (⇧⌘↵)" : selection?.empty === false ? "Run selected SQL" : "Run current statement"),
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
  const closeHistory = () => {
    setShowHistory(false);
    historyButton.current?.focus();
  };
  const chooseHistory = async (text: string) => {
    closeHistory();
    const current = ref.current?.view?.state.doc.toString() ?? value;
    if (current !== text) {
      if (current.trim() && !(await ask(t("Replace the current SQL text?"), { title: t("Query history"), kind: "warning" }))) return;
      onChange(text);
    }
    ref.current?.view?.focus();
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
  const runScope = t(hasSelection ? "Run selected SQL" : "Run current statement");
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
          <button ref={historyButton} type="button" title={t("Query history")} aria-label={t("Query history")} onClick={() => setShowHistory(true)}><History size={14} /></button>
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
      {visible && showHistory && <CommandPalette
        label={t("Query history")}
        placeholder={t("Search SQL history")}
        empty={t(history.length ? "No matching queries" : "No queries in this session yet")}
        preview
        commands={history.map((sql) => ({ id: sql, label: sql.replace(/\s+/g, " "), detail: sql, category: "", run: () => void chooseHistory(sql) }))}
        onClose={closeHistory}
        onRun={(command) => command.run()}
      />}
    </div>
  );
}
