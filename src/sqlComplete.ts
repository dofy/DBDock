import { acceptCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { Kind } from "./api";

const unquote = (s: string) => s.replace(/^[`"[]|[`"\]]$/g, "").split(".").pop() ?? s;

/** Tables named after FROM / JOIN / UPDATE / INTO, including comma lists after FROM. */
export function referencedTables(text: string): string[] {
  const out = new Set<string>();
  const ident = String.raw`[\`"\[]?[\w$.]+[\`"\]]?`;
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:join|update|into)\s+(${ident})`, "gi"))) out.add(unquote(m[1]));
  for (const m of text.matchAll(/\bfrom\s+([\s\S]*?)(?=\bwhere\b|\bjoin\b|\bleft\b|\binner\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|;|\)|$)/gi)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name) out.add(unquote(name));
    }
  }
  return [...out];
}

/**
 * Columns of the tables the statement refers to, offered without a `table.` prefix
 * (lang-sql only completes columns after `table.`).
 */
export function columnSource(schema: Record<string, string[]>) {
  const lower = new Map(Object.keys(schema).map((t) => [t.toLowerCase(), t]));
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (ctx.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    const tables = referencedTables(ctx.state.doc.toString());
    const options = [];
    for (const t of tables) {
      const real = schema[t] ? t : lower.get(t.toLowerCase());
      for (const col of real ? schema[real] : []) options.push({ label: col, type: "property", detail: real, boost: 50 });
    }
    return options.length ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
  };
}

/** SQL language, schema completion, column completion, and Tab to accept a suggestion. */
export function sqlExtensions(kind: Kind, schema: Record<string, string[]>, fixedTable?: string): Extension[] {
  const lang = sql({
    dialect: kind === "mysql" ? MySQL : kind === "postgres" ? PostgreSQL : SQLite,
    schema,
    defaultTable: fixedTable,
    upperCaseKeywords: true,
  });
  const tab = Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }]));
  // With a fixed table, lang-sql's defaultTable already offers its columns unqualified.
  return fixedTable ? [lang, tab] : [lang, lang.language.data.of({ autocomplete: columnSource(schema) }), tab];
}
