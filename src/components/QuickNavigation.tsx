import { useState } from "react";
import { t } from "../i18n";
import { ENV_LABEL, KIND_LABEL, type ConnectionConfig } from "../api";
import { CommandPalette } from "./CommandPalette";
import { targetKey, uniqueTargets, type NavigationCatalog, type NavigationHistory, type NavigationTarget } from "../navigation";

interface Props {
  connections: ConnectionConfig[];
  catalog?: NavigationCatalog;
  history: NavigationHistory;
  onClose: () => void;
  onNavigate: (target: NavigationTarget) => void;
  onFavorite: (target: NavigationTarget) => void;
}

export function QuickNavigation({ connections, catalog, history, onClose, onNavigate, onFavorite }: Props) {
  const [scope, setScope] = useState<"all" | "favorites" | "recent">("all");
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const favoriteKeys = new Set(history.favorites.map(targetKey));
  const choices = scope === "all" ? uniqueTargets([
    ...history.favorites, ...history.recent, ...(catalog?.targets ?? []),
    ...connections.map((connection): NavigationTarget => ({ type: "connection", connectionId: connection.id })),
  ]) : history[scope];
  const targets = new Map(choices.filter((target) => byId.has(target.connectionId)).map((target) => [targetKey(target), target]));
  const commands = [...targets].map(([id, target]) => {
    const connection = byId.get(target.connectionId)!;
    const name = target.type === "connection" ? connection.name
      : target.type === "database" ? target.database : target.type === "schema" ? target.schema : target.table;
    const type = t(target.type === "connection" ? "Connection" : target.type === "database" ? "Database" : target.type === "schema" ? "Schema" : "Table");
    const context = target.type === "connection" ? [KIND_LABEL[connection.kind], connection.database || connection.group].filter(Boolean).join(" / ") : [
      connection.name, target.type !== "database" && target.database !== connection.name ? target.database : "",
      target.type === "table" && target.schema !== target.database ? target.schema : "",
    ].filter(Boolean).join(" / ");
    return { id, label: name, category: `${type} · ${context}`, keywords: `${target.type} ${connection.group} ${connection.env}`,
      favorite: favoriteKeys.has(id),
      badge: ENV_LABEL[connection.env] ? { label: t(ENV_LABEL[connection.env]), className: `env-badge env-${connection.env}` } : undefined,
      run: () => onNavigate(target) };
  });

  return <CommandPalette commands={commands} label={t("Quick switch")} placeholder={t("Find a connection, database, schema or table")}
    empty={t(scope === "favorites" && !commands.length ? "No favorites yet" : scope === "recent" && !commands.length ? "No recent visits yet" : "No matching items")}
    controls={<div className="seg" role="group" aria-label={t("Quick switch")}>
      {(["all", "favorites", "recent"] as const).map((value) => <button key={value} type="button" className={scope === value ? "on" : ""}
        aria-pressed={scope === value} onClick={() => setScope(value)}>{t(value === "all" ? "All" : value === "favorites" ? "Favorites" : "Recent")}</button>)}
    </div>}
    status={scope === "all" ? (catalog?.loadingDatabases ? t("Loading databases…") : catalog?.databaseError) : undefined}
    onClose={onClose} onRun={(command) => command.run()}
    onFavorite={(command) => { const target = targets.get(command.id); if (target) onFavorite(target); }} />;
}
