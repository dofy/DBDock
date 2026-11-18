import { acceptCompletion, autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, SQLite, sql, schemaCompletionSource, keywordCompletionSource } from "@codemirror/lang-sql";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { CompletionSession, Kind } from "./api";
import { sqlContextSource } from "./sqlCompletionContext.ts";
import type { CompletionCatalog } from "./sqlCompletionCatalog";

const sqlDialect = (kind: Kind) => kind === "mysql" ? MySQL : kind === "postgres" ? PostgreSQL : SQLite;
const acceptWithTab = Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }]));

/** Column and keyword completion in the table grid's single-line SQL field. */
export function sqlExtensions(kind: Kind, schema: Record<string, string[]>, fixedTable: string): Extension[] {
  return [sql({ dialect: sqlDialect(kind), schema, defaultTable: fixedTable, upperCaseKeywords: true }), acceptWithTab];
}

const emptySession: CompletionSession = { searchPath: [], schemas: [] };

/** Use the editor connection's namespaces for SQL completion. */
export function querySqlExtensions(kind: Kind, catalog: CompletionCatalog): Extension[] {
  const dialect = sqlDialect(kind);
  const config = { dialect, upperCaseKeywords: true };
  const contextSource = sqlContextSource(dialect, kind);
  const completeKeyword = keywordCompletionSource(dialect, true);
  let pendingContext: CompletionContext | undefined;
  let pendingResult: Promise<{ result: CompletionResult | null; session: CompletionSession } | undefined>;
  const resolveContext = async (ctx: CompletionContext) => {
    const generation = catalog.generation();
    const session = await catalog.session() ?? emptySession;
    const attempted = new Set<string>();
    const attemptedKeys = new Set<string>();
    while (!ctx.aborted && generation === catalog.generation()) {
      const missing = new Set<string>();
      const missingKeys = new Map<string, [string, string]>();
      const result = contextSource(ctx, session, (name) => {
        const columns = catalog.read(name);
        if (!columns && !attempted.has(name)) missing.add(name);
        return columns;
      }, (schema, table) => {
        const keys = catalog.readForeignKeys(schema, table);
        const id = JSON.stringify([schema, table]);
        if (!keys && !attemptedKeys.has(id)) missingKeys.set(id, [schema, table]);
        return keys;
      });
      if (!missing.size && !missingKeys.size) return { result, session };
      missing.forEach((name) => attempted.add(name));
      missingKeys.forEach((_, id) => attemptedKeys.add(id));
      await Promise.all([
        ...[...missing].map(catalog.load),
        ...[...missingKeys.values()].map(([schema, table]) => catalog.loadForeignKeys(schema, table)),
      ]);
    }
  };
  const contextual = (ctx: CompletionContext) => {
    if (pendingContext?.state !== ctx.state || pendingContext.pos !== ctx.pos || pendingContext.explicit !== ctx.explicit) {
      pendingContext = ctx;
      pendingResult = resolveContext(ctx);
    }
    return pendingResult;
  };
  return [sql(config), acceptWithTab, autocompletion({
    override: [
      async (ctx) => (await contextual(ctx))?.result ?? null,
      async (ctx) => {
        const resolved = await contextual(ctx);
        if (!resolved || resolved.result !== null || ctx.aborted) return null;
        const tables = new Map<string, string[]>();
        for (const name of resolved.session.searchPath) {
          const schema = catalog.read(name);
          if (!schema) break;
          for (const [table, columns] of Object.entries(schema)) {
            if (!tables.has(table)) tables.set(table, columns.map(({ name }) => name));
          }
        }
        return schemaCompletionSource({ ...config, schema: Object.fromEntries(tables) })(ctx);
      },
      async (ctx) => (await contextual(ctx))?.result === null && !ctx.aborted ? completeKeyword(ctx) : null,
    ],
    activateOnCompletion: (completion) => ["operator", "namespace"].includes(completion.type ?? ""),
  })];
}
