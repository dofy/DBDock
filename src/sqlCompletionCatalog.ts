import type { CompletionSchema, CompletionSession } from "./api";

export function createCompletionCatalog(
  fetchColumns: (schema: string) => Promise<CompletionSchema>,
  fetchSession: () => Promise<CompletionSession>,
) {
  const entries = new Map<string, { pending: Promise<void>; columns?: CompletionSchema }>();
  let queue = Promise.resolve();
  let path: Promise<CompletionSession | null> | undefined;
  let generation = 0;

  function load(schema: string) {
    const existing = entries.get(schema);
    if (existing) return existing.pending;
    const entry: { pending: Promise<void>; columns?: CompletionSchema } = {
      pending: queue.then(async () => {
        if (entries.get(schema) !== entry) return;
        try {
          entry.columns = await fetchColumns(schema);
        } catch {
          // A failed lookup is cached until an explicit refresh, just like a loaded schema.
        }
      }),
    };
    entries.set(schema, entry);
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
      if (clearColumns) entries.clear();
    },
    load,
    read: (schema: string) => entries.get(schema)?.columns,
    forget(schema: string) {
      entries.delete(schema);
    },
  };
}

export type CompletionCatalog = ReturnType<typeof createCompletionCatalog>;
