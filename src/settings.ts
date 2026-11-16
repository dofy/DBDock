import { useSyncExternalStore } from "react";

/** UI preferences, per machine. */
export interface Settings {
  /** Vim key bindings in every code editor. */
  vim: boolean;
}

const KEY = "dbdock.settings";
const DEFAULTS: Settings = { vim: false };

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { vim: typeof saved.vim === "boolean" ? saved.vim : DEFAULTS.vim };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep for this session */
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Escape inside a code editor belongs to the editor (Vim leaves insert mode), not the dialog. */
export function inEditor(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.(".cm-editor");
}
