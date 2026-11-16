import { t, tf } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText, type ConnectionConfig, type SessionInfo } from "./api";
import { ConnectionForm } from "./components/ConnectionForm";
import { EnvBadge, Home, type MenuAction } from "./components/Home";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { SqlWorkspace } from "./components/SqlWorkspace";
import { RedisWorkspace } from "./components/RedisWorkspace";
import { MongoWorkspace } from "./components/MongoWorkspace";
import { DbIcon } from "./components/DbIcon";
import { ToastProvider, useToast } from "./components/Toast";
import { SettingsDialog } from "./components/SettingsDialog";
import { AboutDialog } from "./components/AboutDialog";
import "./styles.css";
import { X } from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { updateSettings, useDarkMode, useSettings } from "./settings";
import { resolveLocale } from "./i18n";

interface Open {
  conn: ConnectionConfig;
  session: SessionInfo;
}

function Shell() {
  const dark = useDarkMode();
  const settings = useSettings();
  const { language } = settings;
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => {
    const locale = resolveLocale(language);
    document.documentElement.lang = locale;
    void invoke("set_menu_language", { language: locale }).catch(() => {});
  }, [language, settings]);
  useEffect(() => {
    const changed = () => updateSettings({});
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  const toast = useToast();
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [opened, setOpened] = useState<Open[]>([]);
  const [active, setActive] = useState<string | null>(null); // sessionId, null = home
  const [editing, setEditing] = useState<ConnectionConfig | { newInGroup: string } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [homeAction, setHomeAction] = useState<MenuAction | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const dirtyTabs = useRef(new Map<string, Map<string, "dirty" | "busy">>());

  const reload = useCallback(async () => {
    try {
      const [c, g] = await Promise.all([api.listConnections(), api.listGroups()]);
      setConns(c);
      setGroups(g);
    } catch (e) {
      toast("error", errText(e));
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const connect = async (c: ConnectionConfig) => {
    setConnecting(c.id);
    try {
      const session = await api.connect(c.id);
      setOpened((o) => [...o, { conn: c, session }]);
      setActive(session.sessionId);
    } catch (e) {
      toast("error", `${c.name}: ${errText(e)}`);
    } finally {
      setConnecting(null);
    }
  };

  const close = async (sessionId: string) => {
    const tabs = dirtyTabs.current.get(sessionId);
    if (tabs && [...tabs.values()].includes("busy")) { await message(t("Wait for the commit to finish before closing this connection.")); return; }
    if (tabs?.size && !(await ask(t("Discard uncommitted changes in this connection?"), { title: t("Discard changes"), kind: "warning" }))) return;
    dirtyTabs.current.delete(sessionId);
    void api.disconnect(sessionId);
    setOpened((o) => o.filter((x) => x.session.sessionId !== sessionId));
    if (active === sessionId) setActive(null);
  };

  // Native menu: session-level items here, the rest go to the home screen.
  const menuRef = useRef<(id: string) => void>(() => {});
  menuRef.current = (id: string) => {
    const ids = [null, ...opened.map((o) => o.session.sessionId)];
    const cycle = (d: number) => setActive(ids[(ids.indexOf(active) + d + ids.length) % ids.length]);
    switch (id) {
      case "new-connection":
        return setEditing({ newInGroup: "" });
      case "settings":
        return setShowSettings(true);
      case "about":
        return setShowAbout(true);
      case "home":
        return setActive(null);
      case "close-tab":
        if (active) void close(active);
        return;
      case "next-tab":
        return cycle(1);
      case "prev-tab":
        return cycle(-1);
      default:
        setActive(null);
        setHomeAction((a) => ({ id, seq: (a?.seq ?? 0) + 1 }));
    }
  };
  useEffect(() => {
    const un = listen<string>("menu", (e) => menuRef.current(e.payload));
    // Buttons inside the page can trigger the same actions.
    const local = (e: Event) => menuRef.current((e as CustomEvent<string>).detail);
    window.addEventListener("dbdock:menu", local);
    return () => {
      void un.then((f) => f());
      window.removeEventListener("dbdock:menu", local);
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <button className={`top-tab home ${active === null ? "on" : ""}`} onClick={() => setActive(null)}>
           {t("Connections")} </button>
        {opened.map(({ conn, session }) => (
          <div
            key={session.sessionId}
            className={`top-tab ${active === session.sessionId ? "on" : ""} ${conn.env === "production" ? "prod-tab" : ""}`}
            onClick={() => setActive(session.sessionId)}
            title={session.serverVersion}
          >
            <DbIcon kind={conn.kind} size={18} />
            {conn.name}
            <EnvBadge env={conn.env} />
            <button
              className="x"
              onClick={(e) => {
                e.stopPropagation();
                void close(session.sessionId);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </header>

      {active === null && <Home action={homeAction} conns={conns} groups={groups} reload={reload} connecting={connecting} onConnect={(c) => void connect(c)} onEdit={setEditing} />}

      {opened.map(({ session }) => (
        <div key={session.sessionId} className="session" hidden={active !== session.sessionId}>
          {session.kind === "redis" ? (
            <RedisWorkspace session={session} />
          ) : session.kind === "mongodb" ? (
            <MongoWorkspace session={session} dark={dark} />
          ) : (
            <SqlWorkspace session={session} dark={dark} dirtyTabs={dirtyTabs} />
          )}
        </div>
      ))}

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}

      {editing && (
        <ConnectionForm
          initial={"newInGroup" in editing ? undefined : editing}
          initialGroup={"newInGroup" in editing ? editing.newInGroup : undefined}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            toast("ok", tf("Saved {name}", { name: c.name }));
            void reload();
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
