import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText, type ConnectionConfig, type SessionInfo } from "./api";
import { ConnectionForm } from "./components/ConnectionForm";
import { EnvBadge, Home, type MenuAction } from "./components/Home";
import { listen } from "@tauri-apps/api/event";
import { SqlWorkspace } from "./components/SqlWorkspace";
import { RedisWorkspace } from "./components/RedisWorkspace";
import { MongoWorkspace } from "./components/MongoWorkspace";
import { DbIcon } from "./components/DbIcon";
import { ToastProvider, useToast } from "./components/Toast";
import { SettingsDialog } from "./components/SettingsDialog";
import { AboutDialog } from "./components/AboutDialog";
import "./styles.css";
import { X } from "lucide-react";

interface Open {
  conn: ConnectionConfig;
  session: SessionInfo;
}

function useDark() {
  const q = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(q.matches);
  useEffect(() => {
    const f = (e: MediaQueryListEvent) => setDark(e.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, [q]);
  return dark;
}

function Shell() {
  const dark = useDark();
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

  const close = (sessionId: string) => {
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
        return active && close(active);
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
          Connections
        </button>
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
                close(session.sessionId);
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
            <SqlWorkspace session={session} dark={dark} />
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
            toast("ok", `Saved ${c.name}`);
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
