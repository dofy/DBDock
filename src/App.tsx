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
import { CommandPalette } from "./components/CommandPalette";
import type { PaletteCommand } from "./commandPalette";
import { AboutDialog } from "./components/AboutDialog";
import "./styles.css";
import { Database, X } from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { updateSettings, useDarkMode, useSettings } from "./settings";
import { resolveLocale } from "./i18n";
import { clearHealth } from "./healthHistory";
import { SqlHistory } from "./sqlHistory";
import { quitDecision } from "./quitGuard";

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
  const [connecting, setConnecting] = useState<ConnectionConfig[]>([]);
  const connectingIds = useRef(new Map<string, string>());
  const [homeAction, setHomeAction] = useState<MenuAction | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingCommand = useRef<PaletteCommand | null>(null);
  const openCommands = () => {
    if (document.querySelector('.modal-backdrop:not([hidden])') || document.querySelector('.palette-backdrop')) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShowCommand(true);
  };
  useEffect(() => {
    if (showCommand) return;
    const command = pendingCommand.current; pendingCommand.current = null;
    if (command) { command.run(); return; }
    previousFocus.current?.focus(); previousFocus.current = null;
  }, [showCommand]);
  const [heldTabModifier, setHeldTabModifier] = useState<"cmd" | "ctrl" | null>(null);
  const sqlHistory = useRef(new SqlHistory());
  const dirtyTabs = useRef(new Map<string, Map<string, "dirty" | "busy">>());
  const closingSessions = useRef(new Set<string>());
  const quitPending = useRef(false);

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

  const cancelPending = (id: string) => {
    const attemptId = connectingIds.current.get(id);
    if (!attemptId) return;
    connectingIds.current.delete(id);
    setConnecting((pending) => pending.filter((item) => item.id !== id));
    setActive((current) => current === `connecting:${id}` ? null : current);
    void api.cancelConnect(attemptId).catch(() => {});
  };

  const connect = async (c: ConnectionConfig) => {
    const pendingId = `connecting:${c.id}`;
    if (connectingIds.current.has(c.id)) { setActive(pendingId); return; }
    const attemptId = crypto.randomUUID();
    connectingIds.current.set(c.id, attemptId);
    setConnecting((pending) => [...pending, c]);
    setActive(pendingId);
    const stillPending = () => connectingIds.current.get(c.id) === attemptId;
    try {
      await api.beginConnect(attemptId);
      // Cancellation may have happened before the backend registered the attempt.
      if (!stillPending()) await api.cancelConnect(attemptId);
      const session = await api.connect(c.id, attemptId);
      if (!stillPending()) { await api.disconnect(session.sessionId); return; }
      setOpened((o) => [...o, { conn: c, session }]);
      setActive((current) => current === pendingId ? session.sessionId : current);
    } catch (e) {
      if (stillPending()) {
        toast("error", `${c.name}: ${errText(e)}`);
        setActive((current) => current === pendingId ? null : current);
      }
    } finally {
      if (stillPending()) {
        connectingIds.current.delete(c.id);
        setConnecting((pending) => pending.filter((item) => item.id !== c.id));
      }
    }
  };

  const close = async (sessionId: string, confirmClose = false) => {
    if (closingSessions.current.has(sessionId)) return;
    closingSessions.current.add(sessionId);
    try {
      const tabs = dirtyTabs.current.get(sessionId);
      if (tabs && [...tabs.values()].includes("busy")) { await message(t("Wait for the commit to finish before closing this connection.")); return; }
      if (confirmClose) {
        const name = opened.find((item) => item.session.sessionId === sessionId)?.conn.name ?? "";
        const question = tabs?.size
          ? tf('Close connection "{name}" and discard its uncommitted changes?', { name })
          : tf('Close connection "{name}"?', { name });
        if (!(await ask(question, { title: t("Close connection"), kind: "warning", okLabel: t("Close connection"), cancelLabel: t("Cancel") }))) return;
      } else if (tabs?.size && !(await ask(t("Discard uncommitted changes in this connection?"), { title: t("Discard changes"), kind: "warning" }))) return;
      dirtyTabs.current.delete(sessionId);
      void api.disconnect(sessionId);
      setOpened((o) => o.filter((x) => x.session.sessionId !== sessionId));
      setActive((current) => current === sessionId ? null : current);
    } finally {
      closingSessions.current.delete(sessionId);
    }
  };

  const quit = async () => {
    if (quitPending.current) return;
    quitPending.current = true;
    try {
      const busy = [...dirtyTabs.current.values()].some((tabs) => [...tabs.values()].includes("busy"));
      const decision = quitDecision(opened.length, connecting.length, !!document.querySelector('.modal-backdrop:not([hidden])'), busy);
      if (decision === "blocked") { await message(t("Wait for the commit to finish before quitting.")); return; }
      if (decision === "confirm" && !(await ask(t("Quit DBDock? Open connections will close and unsaved edits will be lost."), {
        title: t("Quit DBDock"), kind: "warning", okLabel: t("Quit"), cancelLabel: t("Cancel"),
      }))) return;
      await invoke("confirm_quit");
    } catch (e) {
      toast("error", errText(e));
    } finally {
      quitPending.current = false;
    }
  };

  // Native menu: session-level items here, the rest go to the home screen.
  const menuRef = useRef<(id: string) => void>(() => {});
  menuRef.current = (id: string) => {
    const ids = [null, ...connecting.map((c) => `connecting:${c.id}`), ...opened.map((o) => o.session.sessionId)];
    const cycle = (d: number) => setActive(ids[(ids.indexOf(active) + d + ids.length) % ids.length]);
    if (id.startsWith("session-slot-")) {
      const index = Number(id.slice("session-slot-".length)) - 1;
      if (index >= 0 && index < ids.length) setActive(ids[index]);
      return;
    }
    if (id.startsWith("database-slot-")) {
      if (active) window.dispatchEvent(new CustomEvent("dbdock:cycle-database-tab", { detail: { sessionId: active, index: Number(id.slice("database-slot-".length)) - 1 } }));
      return;
    }
    switch (id) {
      case "quit-app":
        void quit();
        return;
      case "command-palette":
        return openCommands();
      case "new-connection":
        return setEditing({ newInGroup: "" });
      case "settings":
        return setShowSettings(true);
      case "about":
        return setShowAbout(true);
      case "home":
        return setActive(null);
      case "close-tab":
        if (active?.startsWith("connecting:")) cancelPending(active.slice("connecting:".length));
        else if (active) void close(active, true);
        return;
      case "new-sql-tab":
      case "close-database-tab":
        if (active && !document.querySelector('.modal-backdrop:not([hidden])')) {
          window.dispatchEvent(new CustomEvent("dbdock:database-action", { detail: { sessionId: active, action: id } }));
        }
        return;
      case "next-database-tab":
      case "prev-database-tab":
        if (active) window.dispatchEvent(new CustomEvent("dbdock:cycle-database-tab", { detail: { sessionId: active, direction: id === "next-database-tab" ? 1 : -1 } }));
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
    const unModifier = listen<string>("tab-modifier", (e) => setHeldTabModifier(e.payload === "cmd" ? "cmd" : e.payload === "ctrl" ? "ctrl" : null));
    // Buttons inside the page can trigger the same actions.
    const local = (e: Event) => menuRef.current((e as CustomEvent<string>).detail);
    window.addEventListener("dbdock:menu", local);
    const modifier = (e: KeyboardEvent) => setHeldTabModifier(e.metaKey && !e.ctrlKey ? "cmd" : e.ctrlKey && !e.metaKey ? "ctrl" : null);
    const clearModifier = () => setHeldTabModifier(null);
    const numberedTab = (e: KeyboardEvent) => {
      modifier(e);
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!digit || e.altKey || e.shiftKey || e.isComposing) return;
      if (e.ctrlKey && !e.metaKey) menuRef.current(`session-slot-${digit}`);
      else if (e.metaKey && !e.ctrlKey) menuRef.current(`database-slot-${digit}`);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const paletteKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && !e.isComposing && e.key.toLowerCase() === "p") {
        if (document.querySelector('.modal-backdrop:not([hidden])') || document.querySelector('.palette-backdrop')) return;
        e.preventDefault(); e.stopPropagation(); if (!e.repeat) menuRef.current("command-palette");
      }
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
  }, []);

  const activeSession = opened.find((item) => item.session.sessionId === active);
  const noteCategory = t("Connections"), settingsCategory = t("Settings"), databaseCategory = t("Database");
  const action = (id: string, label: string, category: string, keywords: string, shortcut?: string): PaletteCommand => ({ id, label: t(label), category, keywords, shortcut, run: () => menuRef.current(id) });
  const commands: PaletteCommand[] = [
    action("new-connection", "New connection", noteCategory, "create connection", "⌘N"),
    action("home", "Connections", noteCategory, "home connections"),
    action("find", "Search connections", noteCategory, "search find connection", "⌘F"),
    action("new-group", "New group", noteCategory, "create group", "⌘⇧N"),
    action("import", "Import connections", noteCategory, "import connections", "⌘O"),
    action("export", "Export connections", noteCategory, "export connections", "⌘⇧E"),
    action("ssh-hosts", "SSH Hosts", noteCategory, "ssh hosts", "⌘⇧H"),
    action("settings", "Open settings", settingsCategory, "preferences settings", "⌘,"),
    { id:"vim",label:t(settings.vim ? "Disable Vim mode" : "Enable Vim mode"),category:settingsCategory,keywords:"vim editor toggle",run:()=>updateSettings({vim:!settings.vim}) },
    ...(["system","light","dark"] as const).map((theme): PaletteCommand => ({id:`theme-${theme}`,label:`${t("Theme")}: ${t(theme === "system" ? "System" : theme === "light" ? "Light" : "Dark")}`,category:settingsCategory,keywords:`appearance theme ${theme}`,run:()=>updateSettings({theme})})),
    ...(["system","en","zh-CN","zh-TW","ja"] as const).map((language): PaletteCommand => ({id:`language-${language}`,label:`${t("Language")}: ${language === "system" ? t("System") : ({en:"English", "zh-CN":"简体中文", "zh-TW":"繁體中文", ja:"日本語"} as Record<string,string>)[language]}`,category:settingsCategory,keywords:`language locale ${language}`,run:()=>updateSettings({language})})),
    { id:"help",label:t("Help"),category:settingsCategory,keywords:"help documentation",run:()=>{void invoke("open_help").catch((error)=>toast("error",errText(error)));} },
  ];
  if (activeSession && !["redis","mongodb"].includes(activeSession.session.kind)) commands.splice(1,0,action("new-sql-tab","New query",databaseCategory,"new sql query", "⌘T"));
  if (active) commands.push(action("close-tab","Close connection",databaseCategory,"close session"));
  for (const connection of conns) commands.push({id:`connection-${connection.id}`,label:tf("Connect to {name}",{name:connection.name}),category:noteCategory,keywords:`connect ${connection.kind}`,run:()=>{
    const existing=opened.find((item)=>item.conn.id===connection.id);
    if(existing)setActive(existing.session.sessionId);else void connect(connection);
  }});

  return (
    <div className="app">
      <header className="topbar">
        <button className={`top-tab home ${active === null ? "on" : ""}`} onClick={() => setActive(null)}>
           {t("Connections")} {heldTabModifier === "ctrl" && <kbd className="tab-number" aria-hidden="true">1</kbd>}</button>
        {connecting.map((c, index) => <div key={c.id} className={`top-tab ${active === `connecting:${c.id}` ? "on" : ""}`} onClick={() => setActive(`connecting:${c.id}`)}>
          <span className="loading-spinner" aria-hidden="true" />{c.name}<EnvBadge env={c.env} />{heldTabModifier === "ctrl" && index < 8 && <kbd className="tab-number" aria-hidden="true">{index + 2}</kbd>}<button className="x" title={t("Cancel connection")} aria-label={t("Cancel connection")} onClick={(e) => { e.stopPropagation(); cancelPending(c.id); }}><X size={12} /></button>
        </div>)}
        {opened.map(({ conn, session }, index) => (
          <div
            key={session.sessionId}
            className={`top-tab ${active === session.sessionId ? "on" : ""} ${conn.env === "production" ? "prod-tab" : ""}`}
            onClick={() => setActive(session.sessionId)}
            title={session.serverVersion}
          >
            <DbIcon kind={conn.kind} size={18} />
            {conn.name}
            <EnvBadge env={conn.env} />
            {heldTabModifier === "ctrl" && index + connecting.length < 8 && <kbd className="tab-number" aria-hidden="true">{index + connecting.length + 2}</kbd>}
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

      {active === null && <Home action={homeAction} conns={conns} groups={groups} reload={reload} connecting={connecting.map((c) => c.id)} onConnect={(c) => void connect(c)} onEdit={setEditing} />}

      {connecting.map((c) => <div key={c.id} className="session connecting-workspace" hidden={active !== `connecting:${c.id}`}>
        <aside className="connecting-sidebar" aria-hidden="true"><span /><span /><span /><span /></aside>
        <div className="connecting-content" role="status" aria-live="polite">
          <div className="connecting-icon"><Database size={26} aria-hidden="true" /><span className="connecting-spinner" aria-hidden="true"><span className="loading-spinner" /></span></div>
          <strong>{tf("Connecting to {name}…", { name: c.name })}</strong>
          <span>{t("Waiting for the connection or Keychain authorization…")}</span>
        </div>
      </div>)}

      {opened.map(({ conn, session }) => (
        <div key={session.sessionId} className="session" hidden={active !== session.sessionId}>
          {session.kind === "redis" ? (
            <RedisWorkspace session={session} />
          ) : session.kind === "mongodb" ? (
            <MongoWorkspace session={session} dark={dark} />
          ) : (
            <SqlWorkspace session={session} connectionId={conn.id} connectionName={conn.name} database={conn.database} env={conn.env} history={sqlHistory.current} showTabNumbers={active === session.sessionId && heldTabModifier === "cmd"} dark={dark} dirtyTabs={dirtyTabs} />
          )}
        </div>
      ))}

      {showCommand && <CommandPalette commands={commands} onClose={() => setShowCommand(false)} onRun={(command) => { pendingCommand.current = command; setShowCommand(false); }} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}

      {editing && (
        <ConnectionForm
          initial={"newInGroup" in editing ? undefined : editing}
          initialGroup={"newInGroup" in editing ? editing.newInGroup : undefined}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            clearHealth([c.id]);
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
