import { Play, Square } from "lucide-react";
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
  value: string;
  onChange: (v: string) => void;
  /** table name -> columns, for autocomplete */
  schema: Record<string, string[]>;
  dark: boolean;
}

export function QueryView({ sessionId, kind, value, onChange, schema, dark }: Props) {
  const [results, setResults] = useState<QueryResult[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const ref = useRef<ReactCodeMirrorRef>(null);

  const run = async () => {
    const view = ref.current?.view;
    let text = value;
    if (view) {
      const { from, to } = view.state.selection.main;
      if (from !== to) text = view.state.sliceDoc(from, to);
    }
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
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
  const cancel = () => {
    api.cancel(sessionId).catch((e) => setError(errText(e)));
  };
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
            key: "Mod-Enter",
            run: () => {
              void runRef.current();
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
          <button className="danger" onClick={cancel} disabled={kind === "sqlite" || kind === "d1"} title={kind === "sqlite" || kind === "d1" ? "This database cannot cancel a running query" : "Cancel the running query"}>
            <Square size={13} />
            Cancel
          </button>
        ) : (
          <button className="primary" onClick={run}>
            <Play size={13} />
            Run
          </button>
        )}
        {vimOn && <span className="vim-badge static">VIM</span>}
        <span className="muted">{running ? "Running…" : `⌘↵ runs the selection, or everything${vimOn ? " · :w runs" : ""} · Tab accepts a suggestion`}</span>
        <span className="spacer" />
        {results.length > 1 &&
          results.map((r, i) => (
            <button key={i} className={`chip ${i === active ? "on" : ""}`} onClick={() => setActive(i)}>
              {r.columns.length ? `Result ${i + 1}` : `#${i + 1} (${r.rowsAffected ?? 0})`}
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
              {cur.columns.length ? `${cur.rows.length} row(s)` : `${cur.rowsAffected ?? 0} row(s) affected`}
              {cur.truncated && " · truncated to 5000 rows"}
            </div>
          </>
        ) : (
          <div className="grid-empty muted">Results appear here.</div>
        )}
      </div>
    </div>
  );
}
