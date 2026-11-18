import { t } from "../i18n";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { FeedbackIcon, type FeedbackKind } from "./FeedbackIcon";

interface ToastEntry {
  id: number;
  kind: FeedbackKind;
  text: string;
}

const isUrgent = (kind: FeedbackKind) => kind === "error" || kind === "danger";

const Ctx = createContext<(kind: FeedbackKind, text: string) => void>(() => {});
export const useToast = () => useContext(Ctx);

function ToastCard({ item, dismiss }: { item: ToastEntry; dismiss: (id: number) => void }) {
  const { id, kind, text } = item;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const urgent = isUrgent(kind);
  const duration = urgent ? 10000 : kind === "warning" ? 6500 : 4000;
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const timeout = window.setTimeout(() => dismiss(id), duration);
    return () => window.clearTimeout(timeout);
  }, [dismiss, duration, id, paused]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="toast"
      data-feedback-kind={kind}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    >
      <FeedbackIcon kind={kind} size={16} />
      <div className="toast-text">{text}</div>
      <div className="toast-actions">
        {urgent && <button type="button" onClick={() => void copy()} aria-label={t(copied ? "Copied" : "Copy")} title={t(copied ? "Copied" : "Copy")}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>}
        <button type="button" onClick={() => dismiss(id)} aria-label={t("Dismiss")} title={t("Dismiss")}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const [announcement, setAnnouncement] = useState<ToastEntry>();
  const sequence = useRef(0);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const push = useCallback((kind: FeedbackKind, text: string) => {
    const item = { id: ++sequence.current, kind, text };
    setItems((current) => [...current.slice(-4), item]);
    setAnnouncement(item);
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toast-announcement" role="status" aria-atomic="true">
        {announcement && !isUrgent(announcement.kind) && <span key={announcement.id}>{announcement.text}</span>}
      </div>
      <div className="toast-announcement" role="alert" aria-atomic="true">
        {announcement && isUrgent(announcement.kind) && <span key={announcement.id}>{announcement.text}</span>}
      </div>
      <div className="toasts">
        {items.map((item) => <ToastCard key={item.id} item={item} dismiss={dismiss} />)}
      </div>
    </Ctx.Provider>
  );
}
