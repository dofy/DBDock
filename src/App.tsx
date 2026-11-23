import { t, tf } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText, type ConnectionConfig } from "./api";
import { ConnectionForm } from "./components/ConnectionForm";
import { EnvBadge, Home } from "./components/Home";
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
import { Database, Search, X } from "lucide-react";
import { FeedbackDialogProvider, useFeedbackDialog } from "./components/FeedbackDialog";
import { updateSettings, useDarkMode, useSettings } from "./settings";
import { resolveLocale } from "./i18n";
import { clearHealth } from "./healthHistory";
import { SqlHistory } from "./sqlHistory";
import { quitDecision } from "./quitGuard";
import { QuickNavigation } from "./components/QuickNavigation";
import { pruneNavigation, readNavigation, saveNavigation, toggleFavorite, visitTarget,
  type NavigationCatalog, type NavigationTarget } from "./navigation";
import { useAppMenu } from "./useAppMenu";
import { pendingConnectionTabId, useConnectionSessions } from "./useConnectionSessions";

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
  const { ask, message } = useFeedbackDialog();
  const sessions = useConnectionSessions();
  const {
    opened, active, setActive, connecting, navigationRequest, dirtyTabs,
    connect, cancelPending, close,
  } = sessions;
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [editing, setEditing] = useState<ConnectionConfig | { newInGroup: string; fromUrl?: boolean } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [navigation, setNavigation] = useState(() => readNavigation(localStorage));
  const [catalog, setCatalog] = useState<NavigationCatalog>();
  const recordVisit = useCallback((target: NavigationTarget) => setNavigation((current) => visitTarget(current, target)), []);
  useEffect(() => { saveNavigation(localStorage, navigation); }, [navigation]);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingCommand = useRef<PaletteCommand | null>(null);
  const openCommands = () => {
    if (document.querySelector('.modal-backdrop:not([hidden])') || document.querySelector('.palette-backdrop')) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShowCommand(true);
  };
  const openQuick = () => {
    if (document.querySelector('.modal-backdrop:not([hidden]), .palette-backdrop')) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShowQuick(true);
  };
  useEffect(() => {
    if (showCommand || showQuick) return;
    const command = pendingCommand.current; pendingCommand.current = null;
    const focus = previousFocus.current;
    previousFocus.current = null;
    if (command) { command.run(); return; }
    focus?.focus();
  }, [showCommand, showQuick]);
  const [sqlHistory] = useState(() => new SqlHistory());
  const quitPending = useRef(false);

  const reload = useCallback(async () => {
    try {
      const [c, g] = await Promise.all([api.listConnections(), api.listGroups()]);
      setConns(c);
      setGroups(g);
      const ids = new Set(c.map(({ id }) => id));
      setNavigation((current) => pruneNavigation(current, ids));
    } catch (e) {
      toast("error", errText(e));
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const navigate = (target: NavigationTarget) => {
    setShowQuick(false);
    const connection = conns.find((item) => item.id === target.connectionId);
    if (connection) void connect(connection, target);
  };

  const quit = async () => {
    if (quitPending.current) return;
    quitPending.current = true;
    try {
      const busy = [...dirtyTabs.current.values()].some((tabs) => [...tabs.values()].includes("busy"));
      const decision = quitDecision(opened.length, connecting.length, !!document.querySelector('.modal-backdrop:not([hidden])'), busy);
      if (decision === "blocked") { await message(t("Wait for the commit to finish before quitting."), { kind: "warning" }); return; }
      if (decision === "confirm" && !(await ask(t("Quit DBDock? Open connections will close and unsaved edits will be lost."), {
        title: t("Quit DBDock"), kind: "warning", okLabel: t("Quit"),
      }))) return;
      await invoke("confirm_quit");
    } catch (e) {
      toast("error", errText(e));
    } finally {
      quitPending.current = false;
    }
  };

  const { dispatchMenu, heldTabModifier, homeAction, consumeHomeAction } = useAppMenu({
    sessions,
    quit,
    openCommands,
    openQuick,
    openNewConnection: () => setEditing({ newInGroup: "" }),
    openNewConnectionFromUrl: () => setEditing((current) => current ?? { newInGroup: "", fromUrl: true }),
    openSettings: () => setShowSettings(true),
    openAbout: () => setShowAbout(true),
  });

  const activeSession = opened.find((item) => item.session.sessionId === active);
  useEffect(() => {
    if (!activeSession) return;
    const { conn, database } = activeSession;
    recordVisit({ type: "connection", connectionId: conn.id });
    if (database && (conn.kind === "mysql" || conn.kind === "postgres")) {
      recordVisit({ type: "database", connectionId: conn.id, database });
    }
  }, [activeSession, recordVisit]);

  const noteCategory = t("Connections"), settingsCategory = t("Settings"), databaseCategory = t("Database");
  const action = (id: string, label: string, category: string, keywords: string, shortcut?: string): PaletteCommand => ({ id, label: t(label), category, keywords, shortcut, run: () => dispatchMenu(id) });
  const commands: PaletteCommand[] = [
    action("new-connection", "New connection", noteCategory, "create connection", "⌘N"),
    action("new-connection-url", "New connection from URL…", noteCategory, "paste URL create connection", "⇧⌘I"),
    action("quick-switch", "Quick switch", databaseCategory, "go to table database schema favorite recent", "⌘K"),
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
  if (activeSession && !["redis", "mongodb"].includes(activeSession.session.kind)) {
    commands.splice(1, 0,
      action("new-sql-tab", "New query", databaseCategory, "new sql query", "⌘T"),
      action("focus-sql-editor", "Focus SQL editor", databaseCategory, "focus input editor query", "⌘L"),
      action("format-sql", "Format SQL", databaseCategory, "beautify format indent query", "⌘I"),
    );
  }
  if (active) commands.push(
    action("close-database-tab", "Close tab or connection", databaseCategory, "close table query tab session", "⌘W"),
    action("close-tab", "Close connection", databaseCategory, "close session", "⌥⌘W"),
  );
  for (const connection of conns) commands.push({id:`connection-${connection.id}`,label:tf("Connect to {name}",{name:connection.name}),category:noteCategory,keywords:`connect ${connection.kind}`,run:()=>{
    void connect(connection);
  }});

  return (
    <div className="app">
      <header className="topbar">
        <button className={`top-tab home ${active === null ? "on" : ""}`} onClick={() => setActive(null)}>
           {t("Connections")} {heldTabModifier === "ctrl" && <kbd className="tab-number" aria-hidden="true">1</kbd>}</button>
        {connecting.map(({ key, conn, database }, index) => <div key={key} className={`top-tab ${active === pendingConnectionTabId(key) ? "on" : ""}`} onClick={() => setActive(pendingConnectionTabId(key))}>
          <span className="loading-spinner" aria-hidden="true" />{database ? `${conn.name} / ${database}` : conn.name}<EnvBadge env={conn.env} />{heldTabModifier === "ctrl" && index < 8 && <kbd className="tab-number" aria-hidden="true">{index + 2}</kbd>}<button className="x" title={t("Cancel connection")} aria-label={t("Cancel connection")} onClick={(e) => { e.stopPropagation(); cancelPending(key); }}><X size={12} /></button>
        </div>)}
        {opened.map(({ conn, session, database, alternate }, index) => (
          <div
            key={session.sessionId}
            className={`top-tab ${active === session.sessionId ? "on" : ""} ${conn.env === "production" ? "prod-tab" : ""}`}
            onClick={() => setActive(session.sessionId)}
            title={session.serverVersion}
          >
            <DbIcon kind={conn.kind} size={18} />
            {alternate ? `${conn.name} / ${database}` : conn.name}
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
        <button className="top-tab quick-switch" type="button" title={`${t("Quick switch")} (⌘K)`} aria-label={t("Quick switch")} onClick={openQuick}>
          <Search size={15} aria-hidden="true" />
        </button>
      </header>

      {active === null && <Home action={homeAction} onActionHandled={consumeHomeAction} conns={conns} groups={groups} reload={reload} connecting={connecting.filter((item) => !item.database).map(({ conn }) => conn.id)} onConnect={(c) => void connect(c)} onEdit={setEditing} />}

      {connecting.map(({ key, conn, database }) => <div key={key} className="session connecting-workspace" hidden={active !== pendingConnectionTabId(key)}>
        <aside className="connecting-sidebar" aria-hidden="true"><span /><span /><span /><span /></aside>
        <div className="connecting-content" role="status" aria-live="polite">
          <div className="connecting-icon"><Database size={26} aria-hidden="true" /><span className="connecting-spinner" aria-hidden="true"><span className="loading-spinner" /></span></div>
          <strong>{tf("Connecting to {name}…", { name: database ? `${conn.name} / ${database}` : conn.name })}</strong>
          <span>{t("Waiting for the connection or Keychain authorization…")}</span>
        </div>
      </div>)}

      {opened.map(({ conn, session, database }) => (
        <div key={session.sessionId} className="session" hidden={active !== session.sessionId}>
          {session.kind === "redis" ? (
            <RedisWorkspace session={session} />
          ) : session.kind === "mongodb" ? (
            <MongoWorkspace session={session} dark={dark} />
          ) : (
            <SqlWorkspace session={session} connectionId={conn.id} connectionName={conn.name} database={database} env={conn.env} history={sqlHistory}
              visible={active === session.sessionId} showQuick={showQuick && active === session.sessionId} onCatalog={setCatalog}
              navigationRequest={navigationRequest?.sessionId === session.sessionId ? navigationRequest : undefined}
              onNavigate={navigate} onVisit={recordVisit} showTabNumbers={active === session.sessionId && heldTabModifier === "cmd"} dark={dark} dirtyTabs={dirtyTabs} />
          )}
        </div>
      ))}

      {showCommand && <CommandPalette commands={commands} onClose={() => setShowCommand(false)} onRun={(command) => { pendingCommand.current = command; setShowCommand(false); }} />}
      {showQuick && <QuickNavigation connections={conns} catalog={catalog?.sessionId === active ? catalog : undefined} history={navigation}
        onClose={() => setShowQuick(false)} onNavigate={navigate} onFavorite={(target) => setNavigation((current) => toggleFavorite(current, target))} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}

      {editing && (
        <ConnectionForm
          initial={"newInGroup" in editing ? undefined : editing}
          initialGroup={"newInGroup" in editing ? editing.newInGroup : undefined}
          fromUrl={"newInGroup" in editing && editing.fromUrl}
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
    <FeedbackDialogProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </FeedbackDialogProvider>
  );
}
