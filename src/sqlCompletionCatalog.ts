import type { CompletionSchema } from "./api";

export function createCompletionCatalog(fetchColumns: (schema: string) => Promise<CompletionSchema>) {
  const entries = new Map<string, { pending: Promise<void>; columns?: CompletionSchema }>();
  let queue = Promise.resolve();

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
    load,
    read: (schema: string) => entries.get(schema)?.columns,
    reload(schema: string) {
      entries.delete(schema);
      return load(schema);
    },
  };
}

export type CompletionCatalog = ReturnType<typeof createCompletionCatalog>;
