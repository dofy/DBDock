import { acceptCompletion, autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, SQLite, sql, schemaCompletionSource, keywordCompletionSource } from "@codemirror/lang-sql";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { CompletionSchema, Kind } from "./api";
import { sqlContextSource } from "./sqlCompletionContext";

const sqlDialect = (kind: Kind) => kind === "mysql" ? MySQL : kind === "postgres" ? PostgreSQL : SQLite;
const acceptWithTab = Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }]));

/** Column and keyword completion in the table grid's single-line SQL field. */
export function sqlExtensions(kind: Kind, schema: Record<string, string[]>, fixedTable: string): Extension[] {
  return [sql({ dialect: sqlDialect(kind), schema, defaultTable: fixedTable, upperCaseKeywords: true }), acceptWithTab];
}

/** Use context-specific candidates in recognized SQL slots, and CodeMirror's usual sources elsewhere. */
export function querySqlExtensions(kind: Kind, schemaName: string, columns: CompletionSchema): Extension[] {
  const dialect = sqlDialect(kind);
  const schema = Object.fromEntries(Object.entries(columns).map(([table, items]) => [table, items.map(({ name }) => name)]));
  const config = { dialect, schema, upperCaseKeywords: true };
  const contextSource = sqlContextSource(dialect, kind, schemaName, columns);
  const completeSchema = schemaCompletionSource(config);
  const completeKeyword = keywordCompletionSource(dialect, true);
  let previous: CompletionContext | undefined;
  let result: CompletionResult | null = null;
  const contextual = (ctx: CompletionContext) => {
    if (previous?.state !== ctx.state || previous.pos !== ctx.pos || previous.explicit !== ctx.explicit) {
      previous = ctx;
      result = contextSource(ctx);
    }
    return result;
  };
  return [sql(config), acceptWithTab, autocompletion({
    override: [
      contextual,
      (ctx) => contextual(ctx) === null ? completeSchema(ctx) : null,
      (ctx) => contextual(ctx) === null ? completeKeyword(ctx) : null,
    ],
    activateOnCompletion: (completion) => completion.type === "operator",
  })];
}
