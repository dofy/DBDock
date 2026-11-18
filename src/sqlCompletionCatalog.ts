import type { CompletionForeignKey, CompletionSchema, CompletionSession } from "./api";

interface Entry<T> {
  pending: Promise<void>;
  value?: T;
}

export function createCompletionCatalog(
  fetchColumns: (schema: string) => Promise<CompletionSchema>,
  fetchSession: () => Promise<CompletionSession>,
  fetchForeignKeys: (schema: string, table: string) => Promise<CompletionForeignKey[]> = async () => [],
) {
  const entries = new Map<string, Entry<CompletionSchema>>();
  const foreignKeys = new Map<string, Entry<CompletionForeignKey[]>>();
  let queue = Promise.resolve();
  let path: Promise<CompletionSession | null> | undefined;
  let generation = 0;

  function load<T>(cache: Map<string, Entry<T>>, key: string, fetch: () => Promise<T>) {
    const existing = cache.get(key);
    if (existing) return existing.pending;
    const entry: Entry<T> = {
      pending: queue.then(async () => {
        if (cache.get(key) !== entry) return;
        try {
          entry.value = await fetch();
        } catch {
          // A failed lookup is cached until an explicit refresh, just like a loaded schema.
        }
      }),
    };
    cache.set(key, entry);
    queue = entry.pending;
    return entry.pending;
  }

  return {
    session() {
      path ??= fetchSession().catch(() => null);
      return path;
    },
    generation: () => generation,
    invalidate(clearColumns: boolean) {
      generation++;
      path = undefined;
      if (clearColumns) {
        entries.clear();
        foreignKeys.clear();
      }
    },
    load: (schema: string) => load(entries, schema, () => fetchColumns(schema)),
    read: (schema: string) => entries.get(schema)?.value,
    loadForeignKeys: (schema: string, table: string) =>
      load(foreignKeys, JSON.stringify([schema, table]), () => fetchForeignKeys(schema, table)),
    readForeignKeys: (schema: string, table: string) => foreignKeys.get(JSON.stringify([schema, table]))?.value,
    forget(schema: string) {
      entries.delete(schema);
      // The refreshed schema may contain either side of a cached relationship.
      foreignKeys.clear();
    },
  };
}

export type CompletionCatalog = ReturnType<typeof createCompletionCatalog>;
