import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { siGithub } from "simple-icons";
import { BookOpen, Info, Keyboard, Settings as SettingsIcon, X } from "lucide-react";
import { inEditor, updateSettings, useSettings } from "../settings";

/** App preferences. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <SettingsIcon size={16} /> Settings
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <section className="settings-section">
          <h3>
            <Keyboard size={14} /> Editor
          </h3>
          <label className="setting-row">
            <span className="switch">
              <input type="checkbox" checked={s.vim} onChange={(e) => updateSettings({ vim: e.target.checked })} />
              <span />
            </span>
            <div>
              <b>Vim mode</b>
              <p className="muted small">SQL editor, Mongo shell, document editor and the SSH config editor. Esc, hjkl, :w saves (in the SQL editor and shell, :w runs).</p>
            </div>
          </label>
        </section>

        <section className="settings-section">
          <h3>
            <Info size={14} /> About
          </h3>
          <div className="settings-about">
            <img src="/dbdock-icon.svg" alt="" width={40} height={40} />
            <div>
              <b>DBDock {version}</b>
              <span className="muted small">Copyright © 2026 phpz.org · MIT License</span>
            </div>
          </div>
          <div className="row settings-links">
            <button onClick={() => void invoke("open_help")}>
              <BookOpen size={14} /> Help
            </button>
            <button onClick={() => void invoke("open_github")} title="https://github.com/dofy/DBDock">
              <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
                <path d={siGithub.path} fill="currentColor" />
              </svg>
              GitHub
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
