import { t } from "../i18n";
import { useEffect, useState } from "react";
import { inEditor } from "../settings";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardPaste, Database, FileDown, FolderOpen, KeyRound, X } from "lucide-react";
import { errText } from "../api";

interface Detected {
  format: "dbdock" | "tableplus" | "dbeaver" | "urls";
  label: string;
  encrypted: boolean;
  count: number | null;
}

export interface ImportReport {
  source: string;
  added: number;
  updated: number;
  withSecrets: number;
  skipped: string[];
  passwordsNotImported: boolean;
}

interface Props {
  /** Start on the paste tab (File → Paste Connection URLs). */
  pasteFirst?: boolean;
  onClose: () => void;
  onDone: (r: ImportReport) => void;
}

const FORMATS = [
  ["dbdock export", ".json, plain or passphrase-encrypted; passwords included"],
  ["TablePlus", "Connections.plist with groups and tags; passwords stay in TablePlus"],
  ["DBeaver", "data-sources.json with folders, types and SSH tunnels"],
  ["Connection URLs", ".env / text, or paste: postgres://, mysql://, redis://, mongodb+srv://, sqlite:///path, jdbc:…"],
] as const;

/** One import for every source: pick a file (format is detected), use TablePlus, or paste URLs. */
export function ImportDialog({ pasteFirst, onClose, onDone }: Props) {
  const [tab, setTab] = useState<"file" | "paste">(pasteFirst ? "paste" : "file");
  const [tableplus, setTableplus] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; info: Detected } | null>(null);
  const [pass, setPass] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<string | null>("tableplus_file").then(setTableplus).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<ImportReport>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const choose = async (path?: string) => {
    setError(null);
    const p = path ?? (await open({ multiple: false, filters: [{ name: "Connections", extensions: ["json", "plist", "env", "txt", "conf", "*"] }] }));
    if (typeof p !== "string") return;
    try {
      const info = await invoke<Detected>("detect_import_file", { path: p });
      if (info.encrypted) return setFile({ path: p, info });
      await run(() => invoke<ImportReport>("import_file", { path: p }));
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <FileDown size={16} />  {t("Import connections")} </h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
            <X size={14} />
          </button>
        </div>
        <div className="seg" style={{ marginBottom: 12 }}>
          <button className={tab === "file" ? "on" : ""} onClick={() => setTab("file")}>
            <FolderOpen size={14} />  {t("From a file")} </button>
          <button className={tab === "paste" ? "on" : ""} onClick={() => setTab("paste")}>
            <ClipboardPaste size={14} />  {t("Paste URLs")} </button>
        </div>

        {tab === "file" ? (
          file?.info.encrypted ? (
            <div className="form">
              <label>{t("File")}</label>
              <code className="muted small">{file.path}</code>
              <label>{t("Passphrase")}</label>
              <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run(() => invoke<ImportReport>("import_file", { path: file.path, passphrase: pass }))} />
              <span />
              <button className="primary" disabled={busy || !pass} onClick={() => void run(() => invoke<ImportReport>("import_file", { path: file.path, passphrase: pass }))}>
                <KeyRound size={14} />  {t("Decrypt and import")} </button>
            </div>
          ) : (
            <>
              <div className="import-sources">
                <button className="import-source" onClick={() => void choose()} disabled={busy}>
                  <FolderOpen size={20} />
                  <b>{t("Choose a file…")}</b>
                  <span className="muted small">{t("format is detected automatically")}</span>
                </button>
                {tableplus && (
                  <button className="import-source" onClick={() => void choose(tableplus)} disabled={busy}>
                    <Database size={20} />
                    <b>{t("TablePlus on this Mac")}</b>
                    <span className="muted small" title={tableplus}>
                      {tableplus.replace(/^\/Users\/[^/]+/, "~")}
                    </span>
                  </button>
                )}
              </div>
              <ul className="format-list">
                {FORMATS.map(([name, desc]) => (
                  <li key={name}>
                    <b>{name}</b> <span className="muted">— {desc}</span>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <>
            <textarea
              className="paste-box"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder={"One per line, or a whole .env file:\n\nDATABASE_URL=postgres://user:pass@db.example.com:5432/app\nREDIS_URL=redis://:secret@127.0.0.1:6379/0\nmongodb+srv://me:pw@cluster0.example.mongodb.net/shop\nsqlite:///Users/me/data/app.db"}
            />
            <p className="hint">{t("Passwords in the URLs go to the Keychain. Importing the same URL again updates it instead of adding a copy.")}</p>
            <div className="actions">
              <span className="spacer" />
              <button className="primary" disabled={busy || !text.trim()} onClick={() => void run(() => invoke<ImportReport>("import_text", { text }))}>
                <FileDown size={14} />  {t("Import")} </button>
            </div>
          </>
        )}
        {error && <div className="status bad">{error}</div>}
      </div>
    </div>
  );
}
