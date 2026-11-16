import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Circle, AlertCircle, LoaderCircle, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, ENV_LABEL, errText, type ConnectionConfig } from "../api";
import { configurationIssues, summarizeHealth, type ConnectionCheckResult } from "../connectionHealth";
import { beginHealthCheck, finishHealthCheck } from "../healthHistory";
import { healthCheckQueue, HEALTH_CHECK_CONCURRENCY } from "../healthCheckQueue";
import { t, tf } from "../i18n";
import { DbIcon } from "./DbIcon";

type Result = ConnectionCheckResult;
export function HealthDialog({ connections, onClose, onEdit, onDelete }: { connections: ConnectionConfig[]; onClose: () => void; onEdit: (c: ConnectionConfig) => void; onDelete: (c: ConnectionConfig) => Promise<void> }) {
  const [items, setItems] = useState(connections);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { controller.current?.abort(); mounted.current = false; }; }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const issues = items.map(configurationIssues);
  const testable = items.filter((_, i) => issues[i].length === 0);
  const summary = summarizeHealth(items.map((item) => item.id), results);

  async function run() {
    if (runningRef.current || deleteRef.current) return;
    runningRef.current = true;
    const batch = new AbortController();
    controller.current = batch;
    setRunning(true);
    setStopping(false);
    setResults(Object.fromEntries(testable.map((c) => [c.id, { status: "waiting" }])));
    try {
      await Promise.all(testable.map((c) => healthCheckQueue.schedule(c.id, batch.signal, async () => {
        if (mounted.current) setResults((r) => ({ ...r, [c.id]: { status: "running" } }));
        let result: Result;
        const token = beginHealthCheck(c);
        try { await api.checkSavedConnection(c.id); result = { status: "ok" }; }
        catch (error) { result = { status: "error", error: errText(error) }; }
        finishHealthCheck(token, result.status === "ok" ? "ok" : "error");
        if (mounted.current) setResults((r) => ({ ...r, [c.id]: result }));
      })));
    } finally {
      if (controller.current === batch) controller.current = null;
      runningRef.current = false;
      if (mounted.current) { setRunning(false); setStopping(false); }
    }
  }

  const stop = () => { controller.current?.abort(); setStopping(true); };
  async function remove(c: ConnectionConfig) {
    if (runningRef.current || deleteRef.current) return;
    deleteRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      const confirmed = await ask(tf('Delete connection "{name}"? The database is not deleted. Legacy Keychain copies may remain.', { name: c.name }), { title: t("Delete"), kind: "warning" });
      if (!confirmed || !mounted.current) return;
      await onDelete(c);
      if (!mounted.current) return;
      setItems((current) => current.filter((item) => item.id !== c.id));
      setResults((current) => { const next = { ...current }; delete next[c.id]; return next; });
    } catch (error) {
      if (mounted.current) setDeleteError(errText(error));
    } finally {
      deleteRef.current = false;
      if (mounted.current) setDeleting(false);
    }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal health-dialog" role="dialog" aria-modal="true" aria-labelledby="health-title" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head"><h2 id="health-title"><Activity size={17} />{t("Connection health")}</h2><button className="icon-btn" onClick={onClose} aria-label={t("Close")}><X size={14} /></button></div>
      <p className="muted">{tf("Checking {count} connection(s)", { count: items.length })}</p>
      <p className="hint health-intro">{tf("Required fields are checked locally; credentials are checked only during a connection test. Up to {count} tests run at once and may request Keychain access. Stopping waits for running checks to finish.", { count: HEALTH_CHECK_CONCURRENCY })}</p>
      <div className="health-summary" aria-live="polite"><span>{tf("{count} configuration issue(s)", { count: issues.filter((x) => x.length > 0).length })}</span><span>{tf("{count} tested", { count: summary.tested })}</span><span>{tf("{count} connected", { count: summary.connected })}</span><span>{tf("{count} failed", { count: summary.failed })}</span></div>
      {deleteError && <div className="status bad" role="alert">{deleteError}</div>}
      <div className="health-list">
        {!items.length && <div className="empty">{t("No connections to check")}</div>}
        {items.map((c, i) => {
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
            <button disabled={running || deleting} onClick={() => { onClose(); onEdit(c); }}>{t("Edit")}</button>
            <button className="danger" disabled={running || deleting} onClick={() => void remove(c)}>{t("Delete")}</button>
          </div>;
        })}
      </div>
      <div className="actions"><span className="spacer" /><button onClick={onClose}>{t("Close")}</button>{running ? <button onClick={stop} disabled={stopping}>{t(stopping ? "Stopping…" : "Stop")}</button> : <button className="primary" disabled={!testable.length || deleting} onClick={() => void run()}>{tf("Batch test {count} connection(s)", { count: testable.length })}</button>}</div>
    </div>
  </div>;
}
