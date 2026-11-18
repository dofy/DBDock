import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import type { SQLDialect } from "@codemirror/lang-sql";
import type { Text } from "@codemirror/state";
import type { CompletionColumn, CompletionSchema, Kind } from "./api";
import {
  actualName, catalogName, clauseWords, currentStatement, groupTokens, isName, lexerTokens,
  pathEndingAt, qualifiedSources, queryScope, quote, quoted, resolveField, resolves, sameReference, tableIntroducers, word,
  type CatalogLookup, type Token,
} from "./sqlCompletionScope.ts";

const prefix = /^[\p{L}\p{M}\p{N}_$]*$/u;
const predicateClauses = new Set(["WHERE", "HAVING", "ON"]);
const fieldClauses = new Set([...predicateClauses, "SELECT", "GROUP", "ORDER", "SET", "RETURNING"]);
const compare = new Set(["=", "!=", "<>", "<", "<=", ">", ">="]);

function fieldOptions(
  levels: ReturnType<typeof queryScope>["sources"][],
  kind: Kind,
  path?: ReturnType<typeof pathEndingAt>,
  opening?: string,
): Completion[] {
  const refs = path ? qualifiedSources(levels, path.name, path.qualifier, kind) : levels.flat();
  if (path && refs.length !== 1) return [];
  return refs.flatMap((ref, index) => {
    const { name, schema } = ref;
    // An inner alias hides an outer alias of the same name.
    if (!path && name && !qualifiedSources(levels, name, schema, kind).includes(ref)) return [];
    let context = "";
    if (!path && name && (refs.length > 1 || !levels[0].includes(ref))) {
      const duplicate = refs.some((other, i) => i !== index && other.name && sameReference(name, other.name, kind));
      context = (duplicate && schema ? schema.text + "." : "") + name.text + ".";
    }
    return (ref.columns() ?? []).map((column) => ({
      label: column.name,
      displayLabel: context + column.name,
      apply: context + quote(column.name, kind, opening),
      type: "property",
      detail: [name?.text, column.dataType].filter(Boolean).join(" · "),
    }));
  });
}

function booleanColumn(column: CompletionColumn, kind: Kind) {
  const type = column.dataType.trim();
  return /^(bool|boolean)$/i.test(type) || (kind === "mysql" && /^tinyint\(1\)$/i.test(type));
}

function operatorOptions(column: CompletionColumn, assignment: boolean): Completion[] {
  if (assignment) return [{ label: "=", type: "operator", apply: "= " }];
  const options: Completion[] = ["=", "<>"].map((label) => ({ label, type: "operator", apply: label + " " }));
  if (/^(text|(?:var)?char|character|citext)/i.test(column.dataType)) {
    options.push({ label: "LIKE", type: "operator", apply: "LIKE " });
  }
  if (column.nullable) options.push({ label: "IS NULL", type: "keyword" }, { label: "IS NOT NULL", type: "keyword" });
  return options;
}

function valueOptions(column: CompletionColumn, operator: string, assignment: boolean, kind: Kind): Completion[] {
  const is = operator === "IS" || operator === "IS NOT";
  const booleanComparison = assignment || is || operator === "=" || operator === "<>" || operator === "!=";
  const options = booleanComparison && booleanColumn(column, kind) ? ["TRUE", "FALSE"] : [];
  // NULL is valid in assignments and IS predicates. Equality to NULL does not test for missing values.
  if (column.nullable && (assignment || is)) options.push("NULL");
  if (column.nullable && operator === "IS") options.push("NOT NULL");
  return options.map((label) => ({ label, type: "keyword" }));
}

/** Returns null outside known SQL slots, and an empty result for a known slot with no candidates. */
export function sqlContextSource(dialect: SQLDialect, kind: Kind, schemaName: string, schemaNames: readonly string[]) {
  let lastDoc: Text | undefined;
  let tokens: Token[] = [];
  const schemas = [...new Set([...schemaNames, schemaName].filter(Boolean))];
  return (ctx: CompletionContext, readSchema: (name: string) => CompletionSchema | undefined): CompletionResult | null => {
    const { state, pos } = ctx;
    if (lastDoc !== state.doc) {
      tokens = lexerTokens(state.doc, dialect, kind);
      lastDoc = state.doc;
    }
    const statement = currentStatement(tokens, pos);
    const at = statement.find((token) => token.from < pos && pos <= token.to);
    if (at?.type === "String" || at?.type.endsWith("Comment")) return { from: pos, options: [] };
    const opening = at && quoted(at) ? at.text[0] : undefined;
    const from = opening ? at!.from : ctx.matchBefore(/[\p{L}\p{M}\p{N}_$]*/u)?.from ?? pos;
    const to = at?.from === from && isName(at) ? at.to : pos;
    const catalog: CatalogLookup = { kind, defaultSchema: schemaName, schemas, readSchema };
    const tree = groupTokens(statement, Math.max(pos, statement[statement.length - 1]?.to ?? 0));
    const scope = queryScope(tree, [], catalog, [], from);
    const left = scope.tokens.filter((token) => token.to <= from);
    const last = left[left.length - 1];
    const previous = left[left.length - 2];
    let clause: Token | undefined;
    for (let i = left.length - 1; i >= 0; i--) {
      if (clauseWords.has(word(left[i]))) { clause = left[i]; break; }
    }
    const slot = word(clause);
    const result = (options: Completion[]): CompletionResult => opening
      ? { from, to, filter: false, options: options.filter((item) => item.label.toLowerCase().startsWith(
        ctx.state.sliceDoc(from + 1, pos).toLowerCase().replace(/["\]`]$/, ""),
      )) }
      : { from, to, options, validFor: prefix };

    const path = last?.text === "." ? pathEndingAt(left, left.length - 1) : undefined;
    let tableMarker = path && !path.qualifier ? left[path.start - 1] : last;
    if (["ONLY", "LATERAL"].includes(word(tableMarker))) {
      tableMarker = path ? left[path.start - 2] : previous;
    }
    const tableSlot = tableIntroducers.has(word(tableMarker)) ||
      (tableMarker?.text === "," && ["FROM", "JOIN"].includes(slot));
    if (tableSlot) {
      const selected = path ? catalogName(path.name, catalog) : schemaName;
      const tables = selected ? Object.keys(readSchema(selected) ?? {}) : [];
      const visibleCtes = path || word(tableMarker) === "INTO" || word(tableMarker) === "UPDATE" ? [] : scope.ctes;
      const ctes = visibleCtes.filter((cte, i, all) => all.findIndex((item) => sameReference(item.name, cte.name, kind)) === i);
      const options: Completion[] = ctes.map((cte) => {
        const name = actualName(cte.name, kind);
        return { label: name, type: "class", detail: "CTE", apply: quote(name, kind, opening), boost: 2 };
      });
      for (const name of tables) {
        if (ctes.some((cte) => resolves(cte.name, name, kind))) continue;
        options.push({ label: name, type: "class", apply: quote(name, kind, opening) });
      }
      if (!path) {
        const dot = state.sliceDoc(to, to + 1) === "." ? "" : ".";
        for (const name of schemas) {
          options.push({ label: name, displayLabel: name + ".", type: "namespace",
            apply: quote(name, kind, opening) + dot, boost: -2 });
        }
      }
      return result(options);
    }

    const assignment = slot === "SET" && word(scope.tokens[0]) === "UPDATE";
    if (slot === "SET" && !assignment) return null;
    if (!fieldClauses.has(slot) || !last) return null;
    const levels = [scope.sources.filter((ref) => !assignment || ref.updateTarget), ...scope.outer];
    if (path) return result(fieldOptions(levels, kind, path, opening));

    if ((predicateClauses.has(slot) || assignment) && !opening) {
      const isNot = word(last) === "NOT" && word(previous) === "IS";
      const operator = isNot ? "IS NOT" : word(last) === "IS" ? "IS" : last.text;
      const comparison = assignment ? operator === "=" : compare.has(operator) || operator === "IS" || isNot;
      const operand = pathEndingAt(left, left.length - (comparison ? isNot ? 2 : 1 : 0));
      const field = operand && resolveField(operand, levels, kind);
      if (comparison) {
        const values = field ? valueOptions(field, operator, assignment, kind) : [];
        const fields = from < pos && operator !== "IS" && !isNot ? fieldOptions(levels, kind) : [];
        return result([...values, ...fields]);
      }
      if (field && last.to < from) return result(operatorOptions(field, assignment));
    }

    if (last === clause || last.text === "," || last.type === "Operator" ||
        ["ALL", "DISTINCT", "AND", "OR", "BY", "NOT"].includes(word(last))) {
      return result(fieldOptions(levels, kind, undefined, opening));
    }
    return null;
  };
}
