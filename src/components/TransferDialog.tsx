import { t, tf } from "../i18n";
import { useEffect, useState } from "react";
import { inEditor } from "../settings";
import { save } from "@tauri-apps/plugin-dialog";
import { api, errText } from "../api";

type Mode = { kind: "export"; ids?: string[] } | { kind: "import"; path: string };

interface Props {
  mode: Mode;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function TransferDialog({ mode, onClose, onDone }: Props) {
  const [withSecrets, setWithSecrets] = useState(true);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const doExport = async () => {
    if (pass !== pass2) return setError(t("Passphrases do not match"));
    const day = new Date().toISOString().slice(0, 10);
    const path = await save({ defaultPath: `dbdock-connections-${day}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    setBusy(true);
    try {
      const n = await api.exportConnections(path, mode.kind === "export" ? mode.ids : undefined, withSecrets, pass || undefined);
      onDone(`${tf("Exported {count} connection(s) to {path}.", { count: n, path })}${withSecrets ? ` ${t(pass ? "Passwords encrypted." : "Contains plain-text passwords; keep it safe.")}` : ""}`);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (mode.kind !== "import") return;
    setBusy(true);
    try {
      const r = await api.importConnections(mode.path, pass || undefined);
      onDone(tf("Imported {added} new, {updated} updated, {secrets} with passwords.", { added: r.added, updated: r.updated, secrets: r.withSecrets }));
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        {mode.kind === "export" ? (
          <>
            <h2>{t("Export connections")}</h2>
            <p className="muted">{mode.ids ? tf("{count} connection(s)", { count: mode.ids.length }) : t("All connections")}  {t("to a JSON file.")}</p>
            <label className="check">
              <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
               {t("Include passwords and SSH passphrases")} </label>
            {withSecrets && (
              <div className="form" style={{ marginTop: 10 }}>
                <label>{t("Passphrase")}</label>
                <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t("recommended; empty = plain text")} autoFocus />
                <label>{t("Repeat")}</label>
                <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
                <p className="hint">{t("Encrypted with AES-256-GCM, key from Argon2id. Without a passphrase the file holds passwords in plain text.")}</p>
              </div>
            )}
          </>
        ) : (
          <>
            <h2>{t("Import connections")}</h2>
            <p className="muted">{mode.path}</p>
            <div className="form">
              <label>{t("Passphrase")}</label>
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void doImport()}
                autoFocus
              />
            </div>
          </>
        )}
        {error && <div className="status bad">{error}</div>}
        <div className="actions">
          <span className="spacer" />
          <button onClick={onClose}>{t("Cancel")}</button>
          <button className="primary" disabled={busy} onClick={() => void (mode.kind === "export" ? doExport() : doImport())}>
            {mode.kind === "export" ? t("Export…") : t("Import")}
          </button>
        </div>
      </div>
    </div>
  );
}
