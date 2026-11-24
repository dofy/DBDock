import { t, tf } from "./i18n";
import { useEffect, useState } from "react";
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
import { appPaletteCommands } from "./appPaletteCommands";
import { AboutDialog } from "./components/AboutDialog";
import "./styles.css";
import { ArrowDownToLine, Database, Search, X } from "lucide-react";
import { FeedbackDialogProvider } from "./components/FeedbackDialog";
import { updateSettings, useDarkMode, useSettings } from "./settings";
import { resolveLocale } from "./i18n";
import { SqlHistory } from "./sqlHistory";
import { QuickNavigation } from "./components/QuickNavigation";
import type { NavigationTarget } from "./navigation";
import { useAppPalettes } from "./useAppPalettes";
import { useAppMenu } from "./useAppMenu";
import { useAppQuit } from "./useAppQuit";
import { useAppUpdate } from "./useAppUpdate";
import { useConnectionProfiles } from "./useConnectionProfiles";
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
  const sessions = useConnectionSessions();
  const {
    opened, active, setActive, connecting, navigationRequest, dirtyTabs,
    connect, cancelPending, close,
  } = sessions;
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const {
    showCommand, showQuick, openCommands, openQuick, closeCommands, closeQuick, runCommand,
    catalog, setCatalog, navigation, recordVisit, pruneConnectionHistory, toggleFavoriteTarget, navigate: navigateToTarget,
  } = useAppPalettes(connect);
  const {
    conns, groups, editing, setEditing, reload, openNewConnection, openNewConnectionFromUrl, closeEditor, onSaved,
  } = useConnectionProfiles(pruneConnectionHistory);
  const navigate = (target: NavigationTarget) => navigateToTarget(conns, target);
  const [sqlHistory] = useState(() => new SqlHistory());
  const quit = useAppQuit(sessions);
  const appUpdate = useAppUpdate(settings.automaticallyCheckForUpdates, () => quit(true));

  const { dispatchMenu, heldTabModifier, homeAction, consumeHomeAction } = useAppMenu({
    sessions,
    quit,
    openCommands,
    openQuick,
    openNewConnection,
    openNewConnectionFromUrl,
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

  const commands = appPaletteCommands({ conns, active, activeSession, settings, dispatchMenu, connect, toast });

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
        {appUpdate.pending && <button className="top-tab" type="button" disabled={appUpdate.busy} onClick={() => void appUpdate.run()}>
          <ArrowDownToLine size={15} aria-hidden="true" /> {appUpdate.label}
        </button>}
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

      {showCommand && <CommandPalette commands={commands} onClose={closeCommands} onRun={runCommand} />}
      {showQuick && <QuickNavigation connections={conns} catalog={catalog?.sessionId === active ? catalog : undefined} history={navigation}
        onClose={closeQuick} onNavigate={navigate} onFavorite={toggleFavoriteTarget} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} appUpdate={appUpdate} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}

      {editing && (
        <ConnectionForm
          initial={"newInGroup" in editing ? undefined : editing}
          initialGroup={"newInGroup" in editing ? editing.newInGroup : undefined}
          fromUrl={"newInGroup" in editing && editing.fromUrl}
          groups={groups}
          onClose={closeEditor}
          onSaved={onSaved}
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
