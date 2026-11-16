import { useEffect, useState, type ReactNode } from "react";
import { inEditor } from "../settings";

interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: ReactNode;
  /** Suggestions shown under the input (existing groups). */
  options?: string[];
  confirm: string;
  danger?: boolean;
  /** Allow an empty value (e.g. "Ungrouped"). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}

/** Small modal with one text field and optional suggestions. */
export function PromptDialog({ title, label, initial = "", placeholder, hint, options, confirm, danger, allowEmpty, onSubmit, onClose }: PromptProps) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!allowEmpty && !v.trim()) return;
    setBusy(true);
    try {
      await onSubmit(v.trim());
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      setBusy(false);
    }
  };

  const filtered = options?.filter((o) => o.toLowerCase().includes(v.toLowerCase())).slice(0, 12);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <label className="field-label">{label}</label>
        <input
          autoFocus
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          spellCheck={false}
          style={{ width: "100%" }}
        />
        {!!filtered?.length && (
          <div className="suggest">
            {filtered.map((o) => (
              <button key={o} className={`suggest-item ${o === v ? "on" : ""}`} onClick={() => setV(o)}>
                {o}
              </button>
            ))}
          </div>
        )}
        {hint && <p className="hint">{hint}</p>}
        {error && <div className="status bad">{error}</div>}
        <div className="actions">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className={danger ? "danger-solid" : "primary"} disabled={busy || (!allowEmpty && !v.trim())} onClick={() => void submit()}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
