import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { FeedbackIcon, type FeedbackKind } from "./FeedbackIcon";

interface Options {
  kind?: FeedbackKind;
  title?: string;
  okLabel?: string;
  target?: string;
  preview?: string;
}

export type FeedbackAsk = (text: string, options?: Options) => Promise<boolean>;

interface Request extends Options {
  id: number;
  text: string;
  kind: FeedbackKind;
  acknowledge: boolean;
  resolve: (accepted: boolean) => void;
}

const Ctx = createContext<{ ask: FeedbackAsk; message: (text: string, options?: Options) => Promise<void> } | null>(null);

export function useFeedbackDialog() {
  const feedback = useContext(Ctx);
  if (!feedback) throw new Error("FeedbackDialogProvider is missing");
  return feedback;
}

const defaultTitles: Record<FeedbackKind, string> = {
  question: "Confirm",
  info: "Information",
  warning: "Warning",
  danger: "Confirm",
  error: "Error",
  ok: "Success",
};

function FeedbackDialog({ request, onAnswer }: { request: Request; onAnswer: (accepted: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { kind, text, title, target, preview, acknowledge, okLabel } = request;

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    initialFocus.current?.focus();
    return () => { if (element.open) element.close(); };
  }, []);

  const answer = (accepted: boolean) => {
    if (!dialog.current?.open) return;
    dialog.current.close();
    onAnswer(accepted);
  };

  return (
    <dialog
      ref={dialog}
      className="feedback-dialog"
      data-feedback-kind={kind}
      data-has-preview={!!preview}
      role={kind === "danger" ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-details`}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); answer(false); }}
    >
      <div className="feedback-dialog-body">
        <FeedbackIcon kind={kind} size={21} />
        <div className="feedback-dialog-content">
          <h2 id={`${id}-title`}>{title ?? t(defaultTitles[kind])}</h2>
          <div id={`${id}-details`}>
            {text && <p>{text}</p>}
            {target && <p className="feedback-target">{target}</p>}
          </div>
          {preview && <pre className="feedback-preview" tabIndex={0} aria-label={t("Preview SQL")}>{preview}</pre>}
        </div>
      </div>
      <footer className="feedback-dialog-actions">
        {!acknowledge && <button ref={initialFocus} type="button" onClick={() => answer(false)}>{t("Cancel")}</button>}
        <button
          ref={acknowledge ? initialFocus : undefined}
          type="button"
          className={kind === "danger" && !acknowledge ? "feedback-danger-action" : "primary"}
          onClick={() => answer(true)}
        >{okLabel ?? t(acknowledge ? "OK" : "Confirm")}</button>
      </footer>
    </dialog>
  );
}

export function FeedbackDialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);
  const sequence = useRef(0);
  const enqueue = useCallback((text: string, options: Options, acknowledge: boolean) => new Promise<boolean>((resolve) => {
    const request = { ...options, text, acknowledge, resolve, id: ++sequence.current, kind: options.kind ?? (acknowledge ? "info" : "question") } satisfies Request;
    setQueue((current) => [...current, request]);
  }), []);
  const ask: FeedbackAsk = useCallback((text, options = {}) => enqueue(text, options, false), [enqueue]);
  const message = useCallback(async (text: string, options: Options = {}) => { await enqueue(text, options, true); }, [enqueue]);
  const request = queue[0];

  return (
    <Ctx.Provider value={{ ask, message }}>
      {children}
      {request && <FeedbackDialog key={request.id} request={request} onAnswer={(accepted) => {
        setQueue((current) => current.slice(1));
        request.resolve(accepted);
      }} />}
    </Ctx.Provider>
  );
}
