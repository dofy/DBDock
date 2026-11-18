import { acceptCompletion, autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, SQLite, sql, schemaCompletionSource, keywordCompletionSource } from "@codemirror/lang-sql";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { CompletionSchema, Kind } from "./api";
import { sqlContextSource } from "./sqlCompletionContext.ts";
import type { CompletionCatalog } from "./sqlCompletionCatalog";

const sqlDialect = (kind: Kind) => kind === "mysql" ? MySQL : kind === "postgres" ? PostgreSQL : SQLite;
const acceptWithTab = Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }]));

/** Column and keyword completion in the table grid's single-line SQL field. */
export function sqlExtensions(kind: Kind, schema: Record<string, string[]>, fixedTable: string): Extension[] {
  return [sql({ dialect: sqlDialect(kind), schema, defaultTable: fixedTable, upperCaseKeywords: true }), acceptWithTab];
}

/** Use context-specific candidates in recognized SQL slots, and CodeMirror's usual sources elsewhere. */
export function querySqlExtensions(
  kind: Kind, schemaName: string, schemas: readonly string[],
  catalog: CompletionCatalog, tableNames: readonly string[],
): Extension[] {
  const dialect = sqlDialect(kind);
  const config = { dialect, upperCaseKeywords: true };
  const contextSource = sqlContextSource(dialect, kind, schemaName, schemas);
  const completeKeyword = keywordCompletionSource(dialect, true);
  const fallbackTables: CompletionSchema = Object.fromEntries(tableNames.map((name) => [name, []]));
  const schemaSource = (columns: CompletionSchema) => schemaCompletionSource({
    ...config,
    schema: Object.fromEntries(Object.entries(columns).map(([table, items]) => [
      table, items.map(({ name }) => name),
    ])),
  });
  let lastMerged: CompletionSchema | undefined;
  let activeSchema = fallbackTables;
  const read = (name: string) => {
    const columns = catalog.read(name);
    if (name !== schemaName) return columns;
    if (lastMerged !== columns) {
      lastMerged = columns;
      activeSchema = { ...fallbackTables, ...columns };
    }
    return activeSchema;
  };
  let lastColumns: CompletionSchema | undefined;
  let completeSchema = schemaSource(fallbackTables);
  let pendingContext: CompletionContext | undefined;
  let pendingResult: Promise<CompletionResult | null>;
  const resolveContext = async (ctx: CompletionContext) => {
    const missing = new Set<string>();
    const result = contextSource(ctx, (name) => {
      if (!catalog.read(name)) missing.add(name);
      return read(name);
    });
    if (!missing.size || ctx.aborted) return result;
    await Promise.all([...missing].map(catalog.load));
    return ctx.aborted ? null : contextSource(ctx, read);
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
      contextual,
      async (ctx) => {
        if (await contextual(ctx) !== null || ctx.aborted) return null;
        const columns = catalog.read(schemaName);
        if (lastColumns !== columns) {
          lastColumns = columns;
          completeSchema = schemaSource(read(schemaName) ?? {});
        }
        return completeSchema(ctx);
      },
      async (ctx) => await contextual(ctx) === null && !ctx.aborted ? completeKeyword(ctx) : null,
    ],
    activateOnCompletion: (completion) => ["operator", "namespace"].includes(completion.type ?? ""),
  })];
}
