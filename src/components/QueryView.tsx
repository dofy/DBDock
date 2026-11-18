import { backendErrorSummary, t, tf } from "../i18n";
import { AlignLeft, ChevronDown, CircleAlert, Copy, FileDown, FileUp, History, ListTree, Play, Square } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useFeedbackDialog } from "./FeedbackDialog";
import { selectedOrCurrentStatement } from "../sqlStatement";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap, tooltips } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { EditorSelection, Prec } from "@codemirror/state";
import { api, errorDiagnostic, errText, type ExecutionPlan, type Kind, type PlanMode, type QueryResult, type SqlProtection } from "../api";
import type { CompletionCatalog } from "../sqlCompletionCatalog";
import { DataGrid, ResultEmpty } from "./DataGrid";
import { ExecutionPlanView } from "./ExecutionPlanView";
import { querySqlExtensions } from "../sqlComplete";
import { clampSqlEditorShare, DEFAULT_SQL_EDITOR_SHARE, MAX_SQL_EDITOR_SHARE, MIN_SQL_EDITOR_SHARE, updateSettings, useSettings } from "../settings";
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
  focusRequest: number;
  onExecuted: (sql: string) => void;
  value: string;
  onChange: (v: string) => void;
  completionCatalog: CompletionCatalog;
  completionRevision: number;
  onCompletionChanged: (clearColumns: boolean) => void;
  dark: boolean;
}

type PlanState =
  | { mode: PlanMode; status: "running" }
  | { mode: PlanMode; status: "ready"; plan: ExecutionPlan }
  | { mode: PlanMode; status: "error"; error: string };

export function QueryView({ sessionId, protection, connectionName, database, env, kind, history, visible, focusRequest, onExecuted, value, onChange, completionCatalog, completionRevision, onCompletionChanged, dark }: Props) {
  const [results, setResults] = useState<QueryResult[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [showPlan, setShowPlan] = useState(false);
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
  const { ask, message } = useFeedbackDialog();
  const executing = useRef(false);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const runOptionsButton = useRef<HTMLButtonElement>(null);
  const runAllButton = useRef<HTMLButtonElement>(null);
  const initiallyFocused = useRef(false);
  const editorId = useId();
  const [tooltipHost, setTooltipHost] = useState<HTMLDivElement | null>(null);
  const queryPane = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const resize = useRef<{ pointerId: number; startY: number; height: number; share: number } | null>(null);
  const [pendingShare, setPendingShare] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const view = ref.current?.view;
      if (!view || view.dom.closest("[hidden]")) return;
      const overlays = document.querySelectorAll(".modal-backdrop, .palette-backdrop, .feedback-dialog[open]");
      if (Array.from(overlays).some((overlay) => !overlay.closest("[hidden]"))) return;

      view.focus();
      if (initiallyFocused.current) return;
      initiallyFocused.current = true;
      // New blank SQL tabs are ready for typing even when Vim is enabled.
      if (view.state.doc.length === 0) {
        const cm = getCM(view);
        if (cm?.state.vim && !cm.state.vim.insertMode) Vim.handleKey(cm, "i", "user");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, focusRequest]);

  const run = async (all = false) => {
    const view = ref.current?.view;
    const doc = view?.state.doc.toString() ?? value;
    const selection = view?.state.selection.main;
    setShowRunOptions(false);
    if (executing.current || protection === "browseOnly") return;
    const current = all ? { status: "sql" as const, text: doc } : selectedOrCurrentStatement(doc, selection?.from ?? 0, selection?.to ?? 0, kind);
    if (current.status === "ambiguous") {
      toast("warning", t("Select the SQL you want to run, or use Run all"));
      return;
    }
    if (current.status !== "sql" || !current.text.trim()) return;
    const { text } = current;
    executing.current = true;
    let t0: number | undefined;
    let metadataChanged = true;
    try {
      const confirmed = protection === "confirm" && await api.sqlNeedsConfirmation(sessionId, text);
      if (confirmed && !(await confirmSqlWrite(ask, {
        connectionName, env, object: database, sql: text,
        title: t("Confirm SQL execution"), action: t("Run"),
        summary: t(all ? "Run all SQL (⇧⌘↵)" : selection?.empty === false ? "Run selected SQL" : "Run current statement"),
      }))) return;
      setRunning(true);
      setShowPlan(false);
      setError(null);
      onExecuted(text);
      t0 = performance.now();
      const { results: r, metadataChanged: changed } = await api.execute(sessionId, text, confirmed);
      metadataChanged = changed;
      setResults(r);
      // Show the last result that has rows, like most clients.
      const idx = r.map((x) => x.columns.length > 0).lastIndexOf(true);
      setActive(idx >= 0 ? idx : Math.max(0, r.length - 1));
    } catch (e) {
      setError(errorDiagnostic(e));
      setResults([]);
    } finally {
      executing.current = false;
      if (t0 !== undefined) {
        setElapsed(Math.round(performance.now() - t0));
        onCompletionChanged(metadataChanged);
      }
      setRunning(false);
    }
  };
  const explain = async (mode: PlanMode) => {
    setShowRunOptions(false);
    if (executing.current || protection === "browseOnly") return;
    const view = ref.current?.view;
    const selection = view?.state.selection.main;
    const current = selectedOrCurrentStatement(view?.state.doc.toString() ?? value, selection?.from ?? 0, selection?.to ?? 0, kind);
    if (current.status !== "sql") {
      if (current.status === "ambiguous") toast("warning", t("Select one statement for the execution plan"));
      return;
    }
    const { text } = current;
    executing.current = true;
    let submitted = false;
    try {
      const analyze = mode === "analyze";
      if (analyze && !(await confirmSqlWrite(ask, {
        connectionName, env, object: database, sql: text,
        title: t("Run EXPLAIN ANALYZE"), action: t("Analyze"),
        summary: t("EXPLAIN ANALYZE executes this statement and can change data."),
      }))) return;
      setRunning(true);
      setShowPlan(true);
      setPlan({ mode, status: "running" });
      submitted = true;
      const plan = await api.executionPlan(sessionId, text, mode, analyze);
      setPlan({ mode, status: "ready", plan });
    } catch (e) {
      setPlan({ mode, status: "error", error: errorDiagnostic(e) });
    } finally {
      if (submitted && mode === "analyze") onCompletionChanged(true);
      executing.current = false;
      setRunning(false);
    }
  };
  const saveFile = async () => {
    try {
      const path = await save({ defaultPath: "query.sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (path) await api.writeSqlFile(path, ref.current?.view?.state.doc.toString() ?? value);
    } catch (e) { toast("error", errText(e)); }
  };
  const loadFile = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "SQL", extensions: ["sql"] }, { name: "All", extensions: ["*"] }] });
      if (!path || typeof path !== "string") return;
      const text = await api.readSqlFile(path);
      const current = ref.current?.view?.state.doc.toString() ?? value;
      if (current.trim() && text !== current && !(await ask(t("Replace the current SQL text?"), { title: t("Load SQL"), kind: "warning", okLabel: t("Load SQL") }))) return;
      onChange(text);
    } catch (e) { toast("error", errText(e)); }
  };
  const closeHistory = () => {
    setShowHistory(false);
    historyButton.current?.focus();
  };
  const chooseHistory = async (text: string) => {
    closeHistory();
    const current = ref.current?.view?.state.doc.toString() ?? value;
    if (current !== text) {
      if (current.trim() && !(await ask(t("Replace the current SQL text?"), { title: t("Query history"), kind: "warning", okLabel: t("Load into editor") }))) return;
      onChange(text);
    }
    ref.current?.view?.focus();
  };
  const formatEditor = async () => {
    const view = ref.current?.view;
    if (!view) return;
    const { doc, selection } = view.state;
    try {
      const { formatSqlEdit } = await import("../sqlFormat");
      if (view !== ref.current?.view || view.dom.closest("[hidden]") ||
          view.state.doc !== doc || !view.state.selection.eq(selection)) return;
      const { anchor, head } = selection.main;
      const edit = formatSqlEdit(doc.toString(), anchor, head, kind);
      if (edit) view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.text },
        selection: EditorSelection.single(edit.anchor, edit.head),
        scrollIntoView: true,
        userEvent: "format.sql",
      });
      view.focus();
    } catch {
      toast("warning", t("Could not format this SQL"));
    }
  };
  const formatRef = useRef(formatEditor);
  formatRef.current = formatEditor;
  useEffect(() => {
    if (!visible) return;
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; action: string }>).detail;
      if (detail.sessionId === sessionId && detail.action === "format-sql") void formatRef.current();
    };
    window.addEventListener("dbdock:database-action", onAction);
    return () => window.removeEventListener("dbdock:database-action", onAction);
  }, [visible, sessionId]);

  const cancel = () => {
    api.cancel(sessionId).catch((e) => toast("error", errText(e)));
  };
  const saveRef = useRef(saveFile);
  saveRef.current = saveFile;
  const runRef = useRef(run);
  runRef.current = run;

  const { vim: vimOn, sqlEditorShare } = useSettings();
  const share = pendingShare ?? sqlEditorShare;
  const saveShare = (next: number) => {
    const adjusted = clampSqlEditorShare(next);
    if (sqlEditorShare !== adjusted) updateSettings({ sqlEditorShare: adjusted });
  };
  const editorLabel = t("SQL editor");
  const extensions = useMemo(
    () => [
      // Handle ⌘I before Vim can consume it as an editor command.
      Prec.highest(EditorView.domEventHandlers({
        keydown(event) {
          if (event.isComposing || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
              event.key.toLowerCase() !== "i") return false;
          if (!event.repeat) void formatRef.current();
          return true;
        },
      })),
      // Vim handles `:w` and its editing commands.
      ...(vimOn ? [vimExtension(() => void runRef.current())] : []),
      ...querySqlExtensions(kind, completionCatalog),
      // Keep popups outside the editor's clipped scrolling pane, including in WebKit.
      ...(tooltipHost ? [tooltips({ parent: tooltipHost, position: "absolute" })] : []),
      EditorView.contentAttributes.of({ "aria-label": editorLabel }),
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
    [kind, completionCatalog, completionRevision, tooltipHost, vimOn, editorLabel],
  );

  const cur = results[active];
  const runScope = t(hasSelection ? "Run selected SQL" : "Run current statement");
  const focusEditor = () => ref.current?.view?.focus();
  const editSql = protection !== "browseOnly" && <button type="button" onClick={focusEditor}>{t("Back to SQL editor")}</button>;
  const emptyResult = <ResultEmpty illustrated title={t("No rows to display")} detail={t("Review the SQL or adjust its conditions and run it again.")} action={editSql} />;
  const copyError = async () => {
    if (error === null) return;
    try {
      await navigator.clipboard.writeText(error);
      toast("ok", t("Error details copied"));
    } catch {
      toast("error", t("Could not copy the error details"));
    }
  };
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
    <div className="query" ref={queryPane} style={{ gridTemplateRows: `minmax(0, ${share}fr) auto auto minmax(0, ${100 - share}fr)` }}>
      <div className="editor" id={editorId}>
        <CodeMirror ref={ref} value={value} onChange={onChange} onUpdate={(update) => {
          if (update.selectionSet || update.docChanged) setHasSelection(!update.state.selection.main.empty);
        }} extensions={extensions} theme={dark ? "dark" : "light"} height="100%" basicSetup={{ foldGutter: false }} />
      </div>
      <div className="query-tooltip-host" ref={setTooltipHost} />
      <div className="toolbar query-toolbar" ref={toolbar}>
        {running ? (
          <button className="danger" onClick={cancel} disabled={kind === "sqlite" || kind === "d1"} title={kind === "sqlite" || kind === "d1" ? t("This database cannot cancel a running query") : t("Cancel the running query")}>
            <Square size={13} />
             {t("Cancel")} </button>
        ) : (
          <div className="query-run" onMouseDown={(event) => {
            // WebKit can blur the focused button before another button receives its click.
            if (showRunOptions && event.button === 0) event.preventDefault();
          }} onBlur={(event) => {
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
              {(kind === "postgres" || kind === "mysql") && <button type="button" disabled={!value.trim()} onClick={() => {
                runOptionsButton.current?.focus();
                void explain("analyze");
              }}>{t("Analyze query…")}</button>}
            </div>}
          </div>
        )}
        <button type="button" disabled={running || protection === "browseOnly" || !value.trim()} onClick={() => void explain("explain")}
          title={t("Explain the selected SQL or current statement")}>
          <ListTree size={14} aria-hidden="true" />{t("Explain")}
        </button>
        <button type="button" disabled={!value.trim()} onClick={() => void formatEditor()}
          title={`${t("Beautify selection or all SQL")} (⌘I)`}>
          <AlignLeft size={14} aria-hidden="true" />{t("Format SQL")}
        </button>
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
      <div
        className={`query-splitter${pendingShare !== null ? " resizing" : ""}`}
        role="separator"
        tabIndex={0}
        aria-label={t("Resize SQL editor and results")}
        aria-controls={editorId}
        aria-orientation="horizontal"
        aria-valuemin={MIN_SQL_EDITOR_SHARE}
        aria-valuemax={MAX_SQL_EDITOR_SHARE}
        aria-valuenow={share}
        aria-valuetext={tf("SQL editor: {share}%", { share })}
        title={t("Drag to resize. Double-click to reset.")}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || !queryPane.current || !toolbar.current) return;
          const handle = event.currentTarget;
          const height = queryPane.current.clientHeight - toolbar.current.offsetHeight - handle.offsetHeight;
          if (height <= 0) return;
          event.preventDefault();
          handle.focus({ preventScroll: true });
          handle.setPointerCapture(event.pointerId);
          resize.current = { pointerId: event.pointerId, startY: event.clientY, height, share };
          setPendingShare(share);
        }}
        onPointerMove={(event) => {
          const drag = resize.current;
          if (drag?.pointerId === event.pointerId) {
            setPendingShare(clampSqlEditorShare(drag.share + (event.clientY - drag.startY) * 100 / drag.height));
          }
        }}
        onPointerUp={(event) => {
          const drag = resize.current;
          if (drag?.pointerId !== event.pointerId) return;
          resize.current = null;
          setPendingShare(null);
          saveShare(drag.share + (event.clientY - drag.startY) * 100 / drag.height);
        }}
        onLostPointerCapture={(event) => {
          if (resize.current?.pointerId === event.pointerId) {
            resize.current = null;
            setPendingShare(null);
          }
        }}
        onDoubleClick={() => saveShare(DEFAULT_SQL_EDITOR_SHARE)}
        onKeyDown={(event) => {
          const adjustments: Record<string, number> = {
            ArrowUp: share - 3, ArrowDown: share + 3,
            Home: MIN_SQL_EDITOR_SHARE, End: MAX_SQL_EDITOR_SHARE, Enter: DEFAULT_SQL_EDITOR_SHARE,
          };
          const next = adjustments[event.key];
          if (next === undefined) return;
          event.preventDefault();
          saveShare(next);
        }}
      />
      <div className="results" aria-busy={running}>
        {plan && <div className="toolbar query-result-tabs plan-tabs" role="group" aria-label={t("SQL output")}>
          <button type="button" className={`chip${!showPlan ? " on" : ""}`} aria-pressed={!showPlan} onClick={() => setShowPlan(false)}>{t("Query results")}</button>
          <button type="button" className={`chip${showPlan ? " on" : ""}`} aria-pressed={showPlan} onClick={() => setShowPlan(true)}>{t("Execution plan")}</button>
        </div>}
        {showPlan && plan ? plan.status === "ready" ? <ExecutionPlanView plan={plan.plan} mode={plan.mode} />
          : plan.status === "running" ? <ResultEmpty title={t("Waiting for the execution plan…")} />
          : <div className="query-feedback"><div className="query-error" role="alert">
            <strong>{t("Could not generate the execution plan")}</strong><pre>{plan.error}</pre>
          </div></div>
          : <>
        {error === null && results.length > 1 && <div className="toolbar query-result-tabs" role="group" aria-label={t("Query results")}>
          {results.map((r, i) => (
            <button key={i} className={`chip ${i === active ? "on" : ""}`} aria-pressed={i === active} onClick={() => setActive(i)}>
              {r.columns.length ? tf("Result {number}", { number: i + 1 }) : `#${i + 1} (${r.rowsAffected ?? 0})`}
            </button>
          ))}
        </div>}
        {error !== null ? (
          <div className="query-feedback">
            <div className="query-error">
              <div className="query-error-summary" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <div>
                  <strong>{t("Query failed")}</strong>
                  <p>{backendErrorSummary(error) ?? t("Review the SQL and check the error details.")}</p>
                </div>
              </div>
              <details key={error}>
                <summary>{t("Error details")}</summary>
                <button type="button" onClick={() => void copyError()}><Copy size={14} aria-hidden="true" />{t("Copy details")}</button>
                <pre>{error}</pre>
              </details>
              {editSql}
            </div>
          </div>
        ) : cur ? (
          <>
            <DataGrid result={cur} emptyState={!cur.rows.length && !cur.rowsAffected ? emptyResult : undefined} />
            <div className="statusbar query-result-status">
              <span>{cur.columns.length || !cur.rowsAffected ? tf("{count} row(s)", { count: cur.rows.length }) : tf("{count} row(s) affected", { count: cur.rowsAffected })}
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
          <div className="query-feedback">
            {running ? <ResultEmpty title={t("Running…")} /> : elapsed !== null ? emptyResult : protection === "browseOnly"
              ? <ResultEmpty title={t("This connection is in browse-only mode")} detail={t("Open a table from the sidebar to view data.")} />
              : <ResultEmpty illustrated title={t("Run SQL to see results")} detail={t("Use ⌘↵ to run the selected SQL or the current statement.")} />}
          </div>
        )}
        </>}
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
