import { t as translate } from "../i18n";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Copy, X } from "lucide-react";

type Kind = "ok" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}

const Ctx = createContext<(kind: Kind, text: string) => void>(() => {});

/** `toast("ok" | "error" | "info", text)`; errors stay longer and can be copied. */
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (kind: Kind, text: string) => {
      const id = ++seq.current;
      setItems((t) => [...t.slice(-4), { id, kind, text }]);
      setTimeout(() => dismiss(id), kind === "error" ? 10000 : 4000);
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon">{t.kind === "ok" ? "✓" : t.kind === "error" ? "!" : "i"}</span>
            <span className="toast-text">{t.text}</span>
            {t.kind === "error" && (
              <button className="link" onClick={() => navigator.clipboard.writeText(t.text)} title={translate("Copy")}>
                <Copy size={14} />{translate("Copy")} </button>
            )}
            <button className="x" onClick={() => dismiss(t.id)} aria-label={translate("Dismiss")}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
