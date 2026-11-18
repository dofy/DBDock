import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import type { SQLDialect } from "@codemirror/lang-sql";
import type { Text } from "@codemirror/state";
import type { CompletionColumn, CompletionSchema, Kind } from "./api";

interface Token {
  text: string;
  type: string;
  from: number;
  to: number;
}

interface TableRef {
  table: Token;
  schema?: Token;
  qualifier: Token;
  updateTarget: boolean;
  derived?: boolean;
}

interface NamePath {
  qualifier?: Token;
  name: Token;
  start: number;
}

const identifier = /^[\p{L}_][\p{L}\p{M}\p{N}_$]*$/u;
const prefix = /^[\p{L}\p{M}\p{N}_$]*$/u;
const quotedTypes = new Set(["QuotedIdentifier", "Brackets"]);
const setOperations = new Set(["UNION", "INTERSECT", "EXCEPT"]);
const clauseWords = new Set([
  "SELECT", "FROM", "JOIN", "WHERE", "UPDATE", "INTO", "SET", "ON", "USING",
  "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT",
  "RETURNING", "VALUES", "FOR", "WINDOW", "QUALIFY", "FETCH",
]);
const aliasBoundaries = new Set([
  ...clauseWords, "AS", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER",
  "ONLY", "LATERAL", "TABLESAMPLE", "PARTITION", "INDEXED", "USE", "FORCE", "IGNORE", "NOT",
  "AND", "OR", "BY",
]);
const tableIntroducers = new Set(["FROM", "JOIN", "UPDATE", "INTO"]);
const predicateClauses = new Set(["WHERE", "HAVING", "ON"]);
const fieldClauses = new Set([...predicateClauses, "SELECT", "GROUP", "ORDER", "SET", "RETURNING"]);
const compare = new Set(["=", "!=", "<>", "<", "<=", ">", ">="]);
const word = (token?: Token) => token?.type === "Keyword" || token?.type === "Identifier" ? token.text.toUpperCase() : "";
const isName = (token?: Token): token is Token => !!token && (quotedTypes.has(token.type) || identifier.test(token.text));
const quoted = (token: Token) => quotedTypes.has(token.type);

function identifierText(token: Token) {
  if (!quoted(token)) return token.text;
  const closing = token.text[0] === "[" ? "]" : token.text[0];
  const body = token.text.endsWith(closing) ? token.text.slice(1, -1) : token.text.slice(1);
  return body.split(closing + closing).join(closing);
}

function resolves(token: Token, actual: string, kind: Kind) {
  const name = identifierText(token);
  if (kind === "postgres") return actual === (quoted(token) ? name : name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
  return actual.toLowerCase() === name.toLowerCase();
}

function sameReference(left: Token, right: Token, kind: Kind) {
  const name = identifierText(right);
  return resolves(left, kind === "postgres" && !quoted(right) ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : name, kind);
}

function quote(name: string, kind: Kind, opening = kind === "mysql" ? "`" : '"') {
  const closing = opening === "[" ? "]" : opening;
  return opening + name.split(closing).join(closing + closing) + closing;
}

function lexerTokens(doc: Text, dialect: SQLDialect, kind: Kind) {
  const sql = doc.toString();
  const tokens: Token[] = [];
  dialect.language.parser.parse(sql).iterate({ enter(node) {
    const bracketName = (kind === "sqlite" || kind === "d1") && node.name === "Brackets";
    if (node.to > node.from && (bracketName || !node.node.firstChild)) {
      tokens.push({ from: node.from, to: node.to, text: sql.slice(node.from, node.to), type: node.name });
      return false;
    }
  } });
  return tokens;
}

function pathEndingAt(tokens: Token[], end: number): NamePath | undefined {
  const name = tokens[end - 1];
  if (!isName(name) || aliasBoundaries.has(word(name))) return;
  const qualified = tokens[end - 2]?.text === "." && isName(tokens[end - 3]);
  return { name, qualifier: qualified ? tokens[end - 3] : undefined, start: end - (qualified ? 3 : 1) };
}

function tableRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = [];
  let fromList = false;
  for (let i = 0; i < tokens.length; i++) {
    const command = word(tokens[i]);
    if (clauseWords.has(command)) fromList = command === "FROM" || command === "JOIN";
    if (!tableIntroducers.has(command) && !(fromList && tokens[i].text === ",")) continue;
    let cursor = i + 1;
    if (word(tokens[cursor]) === "ONLY") cursor++;
    const first = tokens[cursor++];
    if (first?.text === "(" && tokens[cursor]?.text === ")") {
      cursor++;
      if (word(tokens[cursor]) === "AS") cursor++;
      const alias = tokens[cursor];
      refs.push({ table: first, qualifier: isName(alias) && !aliasBoundaries.has(word(alias)) ? alias : first, updateTarget: false, derived: true });
      continue;
    }
    if (!isName(first) || aliasBoundaries.has(word(first))) continue;
    const qualified = tokens[cursor]?.text === "." && isName(tokens[cursor + 1]);
    const table = qualified ? tokens[cursor + 1] : first;
    if (qualified) cursor += 2;
    if (tokens[cursor]?.text === "(" && command !== "INTO") continue;
    if (word(tokens[cursor]) === "AS") cursor++;
    const alias = tokens[cursor];
    const qualifier = isName(alias) && !aliasBoundaries.has(word(alias)) ? alias : table;
    refs.push({ table, schema: qualified ? first : undefined, qualifier, updateTarget: command === "UPDATE" && i === 0 });
  }
  return refs;
}

function knownColumns(ref: TableRef, catalog: CompletionSchema, schemaName: string, kind: Kind) {
  if (ref.derived || (ref.schema && !resolves(ref.schema, schemaName, kind))) return;
  const matches = Object.keys(catalog).filter((name) => resolves(ref.table, name, kind));
  const exact = kind !== "postgres" && matches.find((name) => name === identifierText(ref.table));
  const table = exact || (matches.length === 1 ? matches[0] : undefined);
  return table === undefined ? undefined : catalog[table];
}

function fieldOptions(refs: TableRef[], kind: Kind, catalog: CompletionSchema, schemaName: string, qualifier?: Token, opening?: string): Completion[] {
  return refs.flatMap((ref) => {
    if (qualifier && !sameReference(qualifier, ref.qualifier, kind)) return [];
    return (knownColumns(ref, catalog, schemaName, kind) ?? []).map((column) => {
      const context = qualifier || refs.length < 2 ? "" : ref.qualifier.text + ".";
      return {
        label: column.name,
        displayLabel: context + column.name,
        apply: context + quote(column.name, kind, opening),
        type: "property",
        detail: [ref.qualifier.text, column.dataType].filter(Boolean).join(" · "),
      };
    });
  });
}

function resolveField(path: NamePath, refs: TableRef[], kind: Kind, catalog: CompletionSchema, schemaName: string) {
  const matching = path.qualifier ? refs.filter((ref) => sameReference(path.qualifier!, ref.qualifier, kind)) : refs;
  const columns = matching.map((ref) => knownColumns(ref, catalog, schemaName, kind));
  if (columns.some((meta) => !meta?.length)) return;
  const found = columns.flatMap((meta) => meta!.filter((column) => resolves(path.name, column.name, kind)));
  return found.length === 1 ? found[0] : undefined;
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

function currentStatement(tokens: Token[], pos: number) {
  let start = 0;
  let end = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== ";") continue;
    if (tokens[i].to <= pos) start = i + 1;
    else { end = i; break; }
  }
  return tokens.slice(start, end);
}

/** Returns null outside known SQL slots, and an empty result for a known slot with no candidates. */
export function sqlContextSource(dialect: SQLDialect, kind: Kind, schemaName: string, catalog: CompletionSchema) {
  let lastDoc: Text | undefined;
  let tokens: Token[] = [];
  return (ctx: CompletionContext): CompletionResult | null => {
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
    const top: Token[] = [];
    let depth = 0;
    let nested = false;
    for (const token of statement) {
      if (token.type.endsWith("Comment")) continue;
      if (token.text === ")") depth = Math.max(0, depth - 1);
      if (!depth) top.push(token);
      if (token.text === "(") depth++;
      if (token.to <= from) nested = depth > 0;
    }
    if (nested) return null;
    let scopeStart = 0;
    let scopeEnd = top.length;
    for (let i = 0; i < top.length; i++) {
      if (!setOperations.has(word(top[i]))) continue;
      if (top[i].to <= from) scopeStart = i + 1;
      else { scopeEnd = i; break; }
    }
    const scope = top.slice(scopeStart, scopeEnd);
    const left = scope.filter((token) => token.to <= from);
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
    const tableMarker = path && !path.qualifier ? left[path.start - 1] : last;
    const tableSlot = tableIntroducers.has(word(tableMarker)) ||
      (word(tableMarker) === "ONLY" && ["FROM", "UPDATE"].includes(word(previous))) ||
      (tableMarker?.text === "," && slot === "FROM");
    if (tableSlot) {
      const names = path && !resolves(path.name, schemaName, kind) ? [] : Object.keys(catalog);
      return result(names.map((name) => ({ label: name, type: "class", apply: quote(name, kind, opening) })));
    }

    const assignment = slot === "SET" && word(scope[0]) === "UPDATE";
    if (slot === "SET" && !assignment) return null;
    if (!fieldClauses.has(slot) || !last) return null;
    // CTE result columns require their own scope resolver.
    if (word(scope[0]) === "WITH") return null;
    const refs = tableRefs(scope).filter((ref) => !assignment || ref.updateTarget);
    if (path && !path.qualifier) return result(fieldOptions(refs, kind, catalog, schemaName, path.name, opening));

    if ((predicateClauses.has(slot) || assignment) && !opening) {
      const isNot = word(last) === "NOT" && word(previous) === "IS";
      const operator = isNot ? "IS NOT" : word(last) === "IS" ? "IS" : last.text;
      const comparison = assignment ? operator === "=" : compare.has(operator) || operator === "IS" || isNot;
      const operand = pathEndingAt(left, left.length - (comparison ? isNot ? 2 : 1 : 0));
      const field = operand && resolveField(operand, refs, kind, catalog, schemaName);
      if (comparison) {
        const values = field ? valueOptions(field, operator, assignment, kind) : [];
        const fields = from < pos && operator !== "IS" && !isNot ? fieldOptions(refs, kind, catalog, schemaName) : [];
        return result([...values, ...fields]);
      }
      if (field && last.to < from) return result(operatorOptions(field, assignment));
    }

    if (last === clause || last.text === "," || last.type === "Operator" || ["AND", "OR", "BY", "NOT"].includes(word(last))) {
      return result(fieldOptions(refs, kind, catalog, schemaName, undefined, opening));
    }
    return null;
  };
}
