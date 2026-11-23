import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pendingConnectionTabId, type useConnectionSessions } from "./useConnectionSessions";

export interface MenuAction {
  id: string;
}

interface Options {
  sessions: Pick<ReturnType<typeof useConnectionSessions>, "active" | "opened" | "connecting" | "setActive" | "closeActive">;
  quit: () => Promise<void>;
  openCommands: () => void;
  openQuick: () => void;
  openNewConnection: () => void;
  openNewConnectionFromUrl: () => void;
  openSettings: () => void;
  openAbout: () => void;
}

export function useAppMenu({
  sessions, quit, openCommands, openQuick, openNewConnection, openNewConnectionFromUrl, openSettings, openAbout,
}: Options) {
  const { active, opened, connecting, setActive, closeActive } = sessions;
  const [homeAction, setHomeAction] = useState<MenuAction | null>(null);
  const consumeHomeAction = useCallback((action: MenuAction) => {
    setHomeAction((current) => current === action ? null : current);
  }, []);
  const [heldTabModifier, setHeldTabModifier] = useState<"cmd" | "ctrl" | null>(null);

  // Native menu: session-level items here, the rest go to the home screen.
  const menuRef = useRef<(id: string) => void>(() => {});
  menuRef.current = (id: string) => {
    if (document.querySelector(".feedback-dialog[open]")) return;
    const ids = [null, ...connecting.map(({ key }) => pendingConnectionTabId(key)), ...opened.map((o) => o.session.sessionId)];
    const cycle = (d: number) => setActive(ids[(ids.indexOf(active) + d + ids.length) % ids.length]);
    const cycleDatabaseTab = (position: { index: number } | { direction: number }) => {
      if (active) window.dispatchEvent(new CustomEvent("dbdock:cycle-database-tab", {
        detail: { sessionId: active, ...position },
      }));
    };
    if ((id.includes("-slot-") || ["next-tab", "prev-tab", "next-database-tab", "prev-database-tab"].includes(id))
      && document.querySelector(".palette-backdrop")) return;
    if (id.startsWith("session-slot-")) {
      const index = Number(id.slice("session-slot-".length)) - 1;
      if (index >= 0 && index < ids.length) setActive(ids[index]);
      return;
    }
    if (id.startsWith("database-slot-")) {
      cycleDatabaseTab({ index: Number(id.slice("database-slot-".length)) - 1 });
      return;
    }
    switch (id) {
      case "quit-app":
        void quit();
        return;
      case "command-palette":
        return openCommands();
      case "quick-switch":
        return openQuick();
      case "new-connection":
        return openNewConnection();
      case "new-connection-url":
        return openNewConnectionFromUrl();
      case "settings":
        return openSettings();
      case "about":
        return openAbout();
      case "home":
        return setActive(null);
      case "close-tab":
      case "new-sql-tab":
      case "focus-sql-editor":
      case "format-sql":
      case "close-database-tab": {
        if (!active || Array.from(document.querySelectorAll(".modal-backdrop, .palette-backdrop"))
          .some((overlay) => !overlay.closest("[hidden]"))) return;
        const unhandled = id === "close-tab" || window.dispatchEvent(new CustomEvent("dbdock:database-action", {
          detail: { sessionId: active, action: id },
          cancelable: true,
        }));
        if (unhandled && (id === "close-tab" || id === "close-database-tab")) closeActive();
        return;
      }
      case "next-database-tab":
      case "prev-database-tab":
        cycleDatabaseTab({ direction: id === "next-database-tab" ? 1 : -1 });
        return;
      case "next-tab":
        return cycle(1);
      case "prev-tab":
        return cycle(-1);
      default:
        setActive(null);
        setHomeAction({ id });
    }
  };
  const dispatchMenu = useCallback((id: string) => menuRef.current(id), []);
  useEffect(() => {
    const un = listen<string>("menu", (e) => dispatchMenu(e.payload));
    const unModifier = listen<string>("tab-modifier", (e) => setHeldTabModifier(e.payload === "cmd" ? "cmd" : e.payload === "ctrl" ? "ctrl" : null));
    // Buttons inside the page can trigger the same actions.
    const local = (e: Event) => dispatchMenu((e as CustomEvent<string>).detail);
    window.addEventListener("dbdock:menu", local);
    const modifier = (e: KeyboardEvent) => setHeldTabModifier(e.metaKey && !e.ctrlKey ? "cmd" : e.ctrlKey && !e.metaKey ? "ctrl" : null);
    const clearModifier = () => setHeldTabModifier(null);
    const numberedTab = (e: KeyboardEvent) => {
      modifier(e);
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!digit || e.altKey || e.shiftKey || e.isComposing) return;
      if (e.ctrlKey && !e.metaKey) dispatchMenu(`session-slot-${digit}`);
      else if (e.metaKey && !e.ctrlKey) dispatchMenu(`database-slot-${digit}`);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const paletteKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      const action = e.shiftKey && key === "p" ? "command-palette" : !e.shiftKey && key === "k" ? "quick-switch" : null;
      if (!action || document.querySelector('.modal-backdrop:not([hidden]), .palette-backdrop')) return;
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) dispatchMenu(action);
    };
    window.addEventListener("keydown", paletteKey, true);
    window.addEventListener("keydown", numberedTab, true);
    window.addEventListener("keyup", modifier, true);
    window.addEventListener("blur", clearModifier);
    return () => {
      void un.then((f) => f());
      void unModifier.then((f) => f());
      window.removeEventListener("dbdock:menu", local);
      window.removeEventListener("keydown", paletteKey, true);
      window.removeEventListener("keydown", numberedTab, true);
      window.removeEventListener("keyup", modifier, true);
      window.removeEventListener("blur", clearModifier);
    };
  }, [dispatchMenu]);

  return { dispatchMenu, heldTabModifier, homeAction, consumeHomeAction };
}
