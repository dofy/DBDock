import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Circle, AlertCircle, LoaderCircle, X } from "lucide-react";
import { api, ENV_LABEL, errText, type ConnectionConfig } from "../api";
import { configurationIssues } from "../connectionHealth";
import { t, tf } from "../i18n";
import { DbIcon } from "./DbIcon";

type Result = { status: "waiting" | "running" | "ok" | "error"; error?: string };
// A closed dialog may still have a native check in flight. Never overlap it
// with a check started in a newly opened dialog.
let inFlight: Promise<void> | null = null;

export function HealthDialog({ connections, onClose, onEdit }: { connections: ConnectionConfig[]; onClose: () => void; onEdit: (c: ConnectionConfig) => void }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopped = useRef(false);
  const runningRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { stopped.current = true; mounted.current = false; }; }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const issues = connections.map(configurationIssues);
  const testable = connections.filter((_, i) => issues[i].length === 0);
  const complete = Object.values(results).filter((r) => r.status === "ok" || r.status === "error").length;

  async function run() {
    if (runningRef.current) return;
    runningRef.current = true;
    stopped.current = false;
    setRunning(true);
    setStopping(false);
    setResults(Object.fromEntries(testable.map((c) => [c.id, { status: "waiting" }])));
    for (const c of testable) {
      if (stopped.current) break;
      setResults((r) => ({ ...r, [c.id]: { status: "running" } }));
      let result: Result;
      while (inFlight) { try { await inFlight; } catch { /* the other dialog handles its own error */ } }
      if (stopped.current) {
        if (mounted.current) setResults((r) => ({ ...r, [c.id]: { status: "waiting" } }));
        break;
      }
      const current = api.checkSavedConnection(c.id);
      inFlight = current;
      try { await current; result = { status: "ok" }; }
      catch (error) { result = { status: "error", error: errText(error) }; }
      finally { if (inFlight === current) inFlight = null; }
      if (!mounted.current) return;
      setResults((r) => ({ ...r, [c.id]: result }));
    }
    runningRef.current = false;
    if (mounted.current) { setRunning(false); setStopping(false); }
  }

  const stop = () => { stopped.current = true; setStopping(true); };
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal health-dialog" role="dialog" aria-modal="true" aria-labelledby="health-title" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head"><h2 id="health-title"><Activity size={17} />{t("Connection health")}</h2><button className="icon-btn" onClick={onClose} aria-label={t("Close")}><X size={14} /></button></div>
      <p className="muted">{tf("Checking {count} connection(s)", { count: connections.length })}</p>
      <p className="hint health-intro">{t("Required fields are checked locally; credentials are checked only during a connection test. Tests run one at a time and may request Keychain access. Stopping waits for the current check to finish.")}</p>
      <div className="health-summary" aria-live="polite"><span>{tf("{count} configuration issue(s)", { count: issues.filter((x) => x.length > 0).length })}</span><span>{tf("{count} tested", { count: complete })}</span><span>{tf("{count} connected", { count: Object.values(results).filter((r) => r.status === "ok").length })}</span><span>{tf("{count} failed", { count: Object.values(results).filter((r) => r.status === "error").length })}</span></div>
      <div className="health-list">
        {connections.map((c, i) => {
          const r = results[c.id]; const problem = issues[i];
          return <div className="health-row" key={c.id}>
            <DbIcon kind={c.kind} size={34} />
            <div className="health-details"><div className="health-name"><b>{c.name}</b>{c.env && <span className={`env-badge env-${c.env}`}>{t(ENV_LABEL[c.env] ?? c.env.toUpperCase())}</span>}{c.group && <span className="muted">{c.group}</span>}</div>
              <div className={problem.length ? "health-warning" : "muted"}>{problem.length ? problem.map(t).join(" · ") : t("Required fields are present")}</div>
              {r?.error && <div className="health-error">{r.error}</div>}
            </div>
            <div className={`health-result ${r?.status ?? ""}`}>
              {r?.status === "running" ? <><LoaderCircle size={14} className="health-spinner" />{t("Testing")}</> : r?.status === "ok" ? <><CheckCircle2 size={14} />{t("Connected")}</> : r?.status === "error" ? <><AlertCircle size={14} />{t("Failed")}</> : <><Circle size={14} />{t(r?.status === "waiting" && running ? "Waiting" : "Not tested")}</>}
            </div>
            <button disabled={running} onClick={() => { onClose(); onEdit(c); }}>{t("Edit")}</button>
          </div>;
        })}
      </div>
      <div className="actions"><span className="spacer" /><button onClick={onClose}>{t("Close")}</button>{running ? <button onClick={stop} disabled={stopping}>{t(stopping ? "Stopping…" : "Stop")}</button> : <button className="primary" disabled={!testable.length} onClick={() => void run()}>{t("Test connections")}</button>}</div>
    </div>
  </div>;
}
