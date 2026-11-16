import { t } from "../i18n";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { BookOpen, X } from "lucide-react";
import { siGithub } from "simple-icons";
import type { Kind } from "../api";
import { DbIcon } from "./DbIcon";

const KINDS: Kind[] = ["mysql", "postgres", "sqlite", "redis", "mongodb", "d1"];

/** Replaces the native About panel, which cannot be styled. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("1.0.0"));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal about" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn about-close" onClick={onClose} aria-label={t("Close")}>
          <X size={14} />
        </button>
        <img className="about-icon" src="/dbdock-icon.svg" alt="" width={112} height={112} />
        <h1>DBDock</h1>
        <p className="about-version">{t("Version")} {version}</p>
        <p className="about-tagline">{t("A database client for the stores you actually use, with SSH built in.")}</p>
        <div className="about-kinds">
          {KINDS.map((k) => (
            <DbIcon key={k} kind={k} size={30} />
          ))}
        </div>
        <div className="about-actions">
          <button onClick={() => void invoke("open_help")}>
            <BookOpen size={14} />  {t("Help")} </button>
          <button onClick={() => void invoke("open_github")}>
            <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
              <path d={siGithub.path} fill="currentColor" />
            </svg>{" "}
            GitHub
          </button>
        </div>
        <p className="about-link">github.com/dofy/DBDock</p>
        <p className="about-copy">Copyright © 2026 phpz.org · MIT License</p>
      </div>
    </div>
  );
}
