export type NavigationTarget =
  | { type: "connection"; connectionId: string }
  | { type: "database"; connectionId: string; database: string }
  | { type: "schema"; connectionId: string; database: string; schema: string }
  | { type: "table"; connectionId: string; database: string; schema: string; table: string };

export interface NavigationHistory {
  favorites: NavigationTarget[];
  recent: NavigationTarget[];
}

export interface NavigationCatalog {
  sessionId: string;
  targets: NavigationTarget[];
  loadingDatabases: boolean;
  databaseError: string | null;
}

const STORAGE_KEY = "dbdock.navigation.v1";
const RECENT_LIMIT = 40;

export function targetKey(target: NavigationTarget): string {
  const key = [target.type, target.connectionId];
  if ("database" in target) key.push(target.database);
  if ("schema" in target) key.push(target.schema);
  if ("table" in target) key.push(target.table);
  return JSON.stringify(key);
}

function isTarget(value: unknown): value is NavigationTarget {
  if (!value || typeof value !== "object" || !("connectionId" in value) ||
      typeof value.connectionId !== "string" || !value.connectionId || !("type" in value)) return false;
  if (value.type === "connection") return true;
  if (!("database" in value) || typeof value.database !== "string") return false;
  if (value.type === "database") return value.database.length > 0;
  if (!("schema" in value) || typeof value.schema !== "string" || !value.schema) return false;
  return value.type === "schema" || (value.type === "table" && "table" in value && typeof value.table === "string" && !!value.table);
}

/** Preserve the first occurrence when merging favorites, MRU and live results. */
export function uniqueTargets(targets: NavigationTarget[]): NavigationTarget[] {
  const keys = new Set<string>();
  return targets.filter((target) => {
    const key = targetKey(target);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function visitTarget(history: NavigationHistory, target: NavigationTarget): NavigationHistory {
  return { ...history, recent: uniqueTargets([target, ...history.recent]).slice(0, RECENT_LIMIT) };
}

export function toggleFavorite(history: NavigationHistory, target: NavigationTarget): NavigationHistory {
  const key = targetKey(target);
  const favorites = history.favorites.some((item) => targetKey(item) === key)
    ? history.favorites.filter((item) => targetKey(item) !== key)
    : [target, ...history.favorites];
  return { ...history, favorites };
}

export function pruneNavigation(history: NavigationHistory, connectionIds: Set<string>): NavigationHistory {
  const favorites = history.favorites.filter((target) => connectionIds.has(target.connectionId));
  const recent = history.recent.filter((target) => connectionIds.has(target.connectionId));
  return favorites.length === history.favorites.length && recent.length === history.recent.length ? history : { favorites, recent };
}

export function readNavigation(storage: Pick<Storage, "getItem">): NavigationHistory {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    return {
      favorites: uniqueTargets(Array.isArray(saved?.favorites) ? saved.favorites.filter(isTarget) : []),
      recent: uniqueTargets(Array.isArray(saved?.recent) ? saved.recent.filter(isTarget) : []).slice(0, RECENT_LIMIT),
    };
  } catch {
    return { favorites: [], recent: [] };
  }
}

export function saveNavigation(storage: Pick<Storage, "setItem">, history: NavigationHistory) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch { /* Navigation still works in memory. */ }
}

/** The database used to create the SQL session. PostgreSQL's default comes from the connector. */
export function sessionDatabase(kind: string, configured: string, defaultSchema: string): string {
  if (kind === "postgres") return configured || "postgres";
  if (kind === "mysql") return defaultSchema || configured;
  return configured;
}

export function destinationKey(connectionId: string, database: string): string {
  return JSON.stringify([connectionId, database]);
}
