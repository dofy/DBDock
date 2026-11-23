import { invoke } from "@tauri-apps/api/core";
import { errText, type ConnectionConfig } from "./api";
import type { PaletteCommand } from "./commandPalette";
import type { useToast } from "./components/Toast";
import { t, tf } from "./i18n";
import { updateSettings, type Settings } from "./settings";
import type { useConnectionSessions } from "./useConnectionSessions";

type Sessions = ReturnType<typeof useConnectionSessions>;

interface Options {
  conns: ConnectionConfig[];
  active: Sessions["active"];
  activeSession: Sessions["opened"][number] | undefined;
  settings: Settings;
  dispatchMenu: (id: string) => void;
  connect: Sessions["connect"];
  toast: ReturnType<typeof useToast>;
}

export function appPaletteCommands({ conns, active, activeSession, settings, dispatchMenu, connect, toast }: Options): PaletteCommand[] {
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
  return commands;
}
