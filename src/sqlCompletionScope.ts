import type { SQLDialect } from "@codemirror/lang-sql";
import type { Text } from "@codemirror/state";
import type { CompletionColumn, CompletionSchema, Kind } from "./api";

export interface Token {
  text: string;
  type: string;
  from: number;
  to: number;
  children?: Token[];
  closed?: boolean;
}

export interface NamePath {
  name: Token;
  qualifier?: Token;
  schema?: Token;
  start: number;
}

interface Relation {
  name?: Token;
  schema?: Token;
  columns: () => readonly CompletionColumn[] | undefined;
}

interface BaseTable {
  schema: string;
  table: string;
  columns: readonly CompletionColumn[];
}

export interface Source extends Relation {
  at: number;
  introducer: string;
  baseTable: () => BaseTable | undefined;
  group?: Token;
  lateral: boolean;
  updateTarget: boolean;
}

interface Cte {
  name: Token;
  columns: () => readonly CompletionColumn[] | undefined;
}

interface Scope {
  tokens: Token[];
  ctes: Cte[];
  sources: Source[];
  outer: Source[][];
}

export interface CatalogLookup {
  kind: Kind;
  searchPath: readonly string[];
  schemas: readonly string[];
  readSchema: (name: string) => CompletionSchema | undefined;
}

const identifier = /^[\p{L}_][\p{L}\p{M}\p{N}_$]*$/u;
const quotedTypes = new Set(["QuotedIdentifier", "Brackets"]);
const setOperations = new Set(["UNION", "INTERSECT", "EXCEPT"]);
export const clauseWords = new Set([
  "SELECT", "FROM", "JOIN", "WHERE", "UPDATE", "INTO", "SET", "ON", "USING",
  "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT",
  "RETURNING", "VALUES", "FOR", "WINDOW", "QUALIFY", "FETCH",
]);
const aliasBoundaries = new Set([
  ...clauseWords, "AS", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER",
  "ONLY", "LATERAL", "TABLESAMPLE", "PARTITION", "INDEXED", "USE", "FORCE", "IGNORE", "NOT",
  "AND", "OR", "BY",
]);
export const tableIntroducers = new Set(["FROM", "JOIN", "UPDATE", "INTO"]);
export const word = (token?: Token) => token?.type === "Keyword" || token?.type === "Identifier" ? token.text.toUpperCase() : "";
export const isName = (token?: Token): token is Token => !!token && (quotedTypes.has(token.type) || identifier.test(token.text));
export const quoted = (token: Token) => quotedTypes.has(token.type);

export function identifierText(token: Token) {
  if (!quoted(token)) return token.text;
  const closing = token.text[0] === "[" ? "]" : token.text[0];
  const body = token.text.endsWith(closing) ? token.text.slice(1, -1) : token.text.slice(1);
  return body.split(closing + closing).join(closing);
}

export function resolves(token: Token, actual: string, kind: Kind) {
  const name = identifierText(token);
  if (kind === "postgres") return actual === (quoted(token) ? name : name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
  return actual.toLowerCase() === name.toLowerCase();
}

export function sameReference(left: Token, right: Token, kind: Kind) {
  const name = identifierText(right);
  return resolves(left, kind === "postgres" && !quoted(right) ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : name, kind);
}

export function quote(name: string, kind: Kind, opening = kind === "mysql" ? "`" : '"') {
  const closing = opening === "[" ? "]" : opening;
  return opening + name.split(closing).join(closing + closing) + closing;
}

export function lexerTokens(doc: Text, dialect: SQLDialect, kind: Kind) {
  const sql = doc.toString();
  const tokens: Token[] = [];
  dialect.language.parser.parse(sql).iterate({ enter(node) {
    const bracketName = (kind === "sqlite" || kind === "d1") && node.name === "Brackets";
    if (node.to > node.from && (bracketName || !node.node.firstChild)) {
      const text = sql.slice(node.from, node.to);
      const previous = tokens[tokens.length - 1];
      if (node.name === "String" && text.startsWith("'") && previous?.type === "String" &&
          previous.to === node.from && previous.text.endsWith("'")) {
        // The lexer splits a doubled quote into adjacent string tokens.
        previous.text += text;
        previous.to = node.to;
      } else {
        tokens.push({ from: node.from, to: node.to, text, type: node.name });
      }
      return false;
    }
  } });
  return tokens;
}

export function currentStatement(tokens: Token[], pos: number) {
  let start = 0;
  let end = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== ";") continue;
    if (tokens[i].to <= pos) start = i + 1;
    else { end = i; break; }
  }
  return tokens.slice(start, end);
}

// Keep parentheses in the lexer output, including unclosed ones in an editor draft.
export function groupTokens(tokens: Token[], end: number): Token[] {
  const root: Token[] = [];
  const stack: Token[] = [];
  const current = () => stack[stack.length - 1]?.children ?? root;
  for (const token of tokens) {
    if (token.type.endsWith("Comment")) continue;
    if (token.type === "(") {
      const group: Token = { ...token, type: "Group", to: end, children: [] };
      current().push(group);
      stack.push(group);
    } else if (token.type === ")" && stack.length) {
      const group = stack.pop()!;
      group.closed = true;
      group.to = token.to;
    } else {
      current().push(token);
    }
  }
  return root;
}

function within(group: Token, pos: number) {
  return !!group.children && group.from < pos && (group.closed ? pos < group.to : pos <= group.to);
}

function nameToken(token?: Token): token is Token {
  return isName(token) && !aliasBoundaries.has(word(token));
}

export function pathEndingAt(tokens: Token[], end: number): NamePath | undefined {
  const name = tokens[end - 1];
  if (!nameToken(name)) return;
  let start = end - 1;
  let qualifier: Token | undefined;
  let schema: Token | undefined;
  if (tokens[start - 1]?.text === "." && nameToken(tokens[start - 2])) {
    start -= 2;
    qualifier = tokens[start];
    if (tokens[start - 1]?.text === "." && nameToken(tokens[start - 2])) {
      start -= 2;
      schema = tokens[start];
    }
  }
  return { name, qualifier, schema, start };
}

export function actualName(token: Token, kind: Kind) {
  const name = identifierText(token);
  return kind === "postgres" && !quoted(token) ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : name;
}

function findTable(entries: CompletionSchema, token: Token, kind: Kind): string | undefined {
  const name = actualName(token, kind);
  if (Object.prototype.hasOwnProperty.call(entries, name)) return name;
  const matches = Object.keys(entries).filter((key) => resolves(token, key, kind));
  return matches.length === 1 ? matches[0] : undefined;
}

export function catalogName(token: Token, catalog: CatalogLookup) {
  const name = actualName(token, catalog.kind);
  if (catalog.schemas.includes(name)) return name;
  const matches = catalog.schemas.filter((schema) => resolves(token, schema, catalog.kind));
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveTable(table: Token, schema: Token | undefined, catalog: CatalogLookup): BaseTable | undefined {
  const schemaName = schema ? catalogName(schema, catalog) : undefined;
  const path = schema ? (schemaName ? [schemaName] : []) : catalog.searchPath;
  for (const name of path) {
    const entries = catalog.readSchema(name);
    if (!entries) return; // An earlier, unknown schema may shadow all later matches.
    const match = findTable(entries, table, catalog.kind);
    if (match !== undefined) return { schema: name, table: match, columns: entries[match] };
  }
}

const isSelect = (tokens: Token[]) => ["SELECT", "WITH"].includes(word(tokens[0]));

function splitList(tokens: Token[]) {
  const parts: Token[][] = [[]];
  for (const token of tokens) {
    if (token.text === ",") parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts;
}

function columnNames(group?: Token) {
  if (!group?.children || !group.closed) return [];
  const names = splitList(group.children);
  return names.every((part) => part.length === 1 && nameToken(part[0])) ? names.map(([token]) => token) : [];
}

function renameColumns(names: Token[], columns: readonly (CompletionColumn | undefined)[] | undefined, kind: Kind) {
  return names.map((token, i) => {
    const name = actualName(token, kind);
    return { dataType: "", nullable: false, ...columns?.[i], name };
  });
}

function memo<T>(resolve: () => T): () => T {
  let resolved = false;
  let value: T;
  return () => {
    if (!resolved) {
      value = resolve();
      resolved = true;
    }
    return value;
  };
}

function withDefinitions(tokens: Token[]) {
  const definitions: { name: Token; names: Token[]; query: Token }[] = [];
  if (word(tokens[0]) !== "WITH") return { definitions, body: tokens, recursive: false };
  const recursive = word(tokens[1]) === "RECURSIVE";
  let cursor = recursive ? 2 : 1;
  while (nameToken(tokens[cursor])) {
    const name = tokens[cursor++];
    const names = tokens[cursor]?.children ? columnNames(tokens[cursor++]) : [];
    if (word(tokens[cursor++]) !== "AS") break;
    if (word(tokens[cursor]) === "NOT") cursor++;
    if (word(tokens[cursor]) === "MATERIALIZED") cursor++;
    const query = tokens[cursor++];
    if (!query?.children) break;
    definitions.push({ name, names, query });
    if (tokens[cursor]?.text !== ",") return { definitions, body: tokens.slice(cursor), recursive };
    cursor++;
  }
  return { definitions, body: [], recursive };
}

function queryArm(tokens: Token[], at: number) {
  let start = 0;
  let end = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (!setOperations.has(word(tokens[i]))) continue;
    if (tokens[i].to <= at) start = i + 1;
    else { end = i; break; }
  }
  if (start && ["ALL", "DISTINCT"].includes(word(tokens[start]))) start++;
  return tokens.slice(start, end);
}

function tableRefs(tokens: Token[], ctes: Cte[], catalog: CatalogLookup, outer: Source[][], budget: number): Source[] {
  const refs: Source[] = [];
  let fromList = false;
  for (let i = 0; i < tokens.length; i++) {
    const command = word(tokens[i]);
    if (clauseWords.has(command)) fromList = command === "FROM" || command === "JOIN";
    if (!tableIntroducers.has(command) && !(fromList && tokens[i].text === ",")) continue;
    let cursor = i + 1;
    const lateral = word(tokens[cursor]) === "LATERAL";
    if (lateral || word(tokens[cursor]) === "ONLY") cursor++;
    const first = tokens[cursor++];
    const derived = first?.children && isSelect(first.children);
    if (!derived && !nameToken(first)) continue;
    const qualified = !derived && tokens[cursor]?.text === "." && nameToken(tokens[cursor + 1]);
    const table = qualified ? tokens[cursor + 1] : first;
    const schema = qualified ? first : undefined;
    if (qualified) cursor += 2;
    const functionSource = !derived && command !== "INTO" && !!tokens[cursor]?.children;
    if (functionSource) cursor++;
    if (word(tokens[cursor]) === "AS") cursor++;
    const alias = nameToken(tokens[cursor]) ? tokens[cursor++] : undefined;
    const names = alias ? columnNames(tokens[cursor]) : [];
    const visibleOuter = lateral ? [refs.slice(), ...outer] : [];
    const cte = !derived && !functionSource && !schema
      ? ctes.find((entry) => sameReference(table, entry.name, catalog.kind))
      : undefined;
    const baseTable = memo(() => derived || functionSource || cte ? undefined : resolveTable(table, schema, catalog));
    refs.push({
      at: tokens[i].from,
      introducer: command || tokens[i].text,
      baseTable,
      name: alias ?? (derived ? undefined : table),
      schema: alias ? undefined : schema,
      group: derived ? first : undefined,
      lateral,
      updateTarget: command === "UPDATE" && i === 0,
      columns: memo(() => {
        if (functionSource) return names.length ? renameColumns(names, undefined, catalog.kind) : undefined;
        const projected = derived
          ? queryOutput(first.children!, ctes, catalog, visibleOuter, budget - 1)
          : cte ? cte.columns() : baseTable()?.columns;
        if (!names.length) return projected?.filter((item): item is CompletionColumn => !!item);
        const renamed = renameColumns(names, projected, catalog.kind);
        // In a derived column list, any remaining output keeps its original name.
        return [...renamed, ...(projected?.slice(names.length).filter((item): item is CompletionColumn => !!item) ?? [])];
      }),
    });
  }
  return refs;
}

export function qualifiedSources(levels: Source[][], name: Token, schema: Token | undefined, kind: Kind) {
  for (const refs of levels) {
    const matches = refs.filter((ref) => ref.name && sameReference(name, ref.name, kind)
      && (!schema || (ref.schema && sameReference(schema, ref.schema, kind))));
    if (matches.length) return matches;
  }
  return [];
}

export function resolveField(path: NamePath, levels: Source[][], kind: Kind): CompletionColumn | undefined {
  const { name, qualifier, schema } = path;
  const scopes = qualifier ? [qualifiedSources(levels, qualifier, schema, kind)] : levels;
  for (const refs of scopes) {
    const columns = refs.map((ref) => ref.columns());
    if (columns.some((meta) => !meta?.length)) return;
    const found = columns.flatMap((meta) => meta!.filter((column) => resolves(name, column.name, kind)));
    if (found.length) return found.length === 1 ? found[0] : undefined;
  }
}

function selectColumns(scope: Scope, kind: Kind) {
  const { tokens, sources, outer } = scope;
  if (word(tokens[0]) !== "SELECT") return;
  let start = ["ALL", "DISTINCT", "DISTINCTROW"].includes(word(tokens[1])) ? 2 : 1;
  if (word(tokens[1]) === "DISTINCT" && word(tokens[2]) === "ON" && tokens[3]?.children) start = 4;
  const end = tokens.findIndex((token, i) => i >= start && clauseWords.has(word(token)));
  const levels = [sources, ...outer];
  const columns: (CompletionColumn | undefined)[] = [];
  for (const part of splitList(tokens.slice(start, end === -1 ? undefined : end))) {
    if (!part.length) continue;
    const last = part[part.length - 1];
    if (last.text === "*" && (part.length === 1 || part[part.length - 2]?.text === ".")) {
      const relation = pathEndingAt(part, part.length - 2);
      const refs = relation ? qualifiedSources(levels, relation.name, relation.qualifier, kind) : sources;
      const found = refs.map((ref) => ref.columns());
      // An unknown wildcard also makes the positions of subsequent aliases unknown.
      if (!found.length || found.some((meta) => !meta?.length)) return;
      columns.push(...found.flatMap((meta) => meta!));
      continue;
    }
    const previous = part[part.length - 2];
    const explicit = word(previous) === "AS";
    const implicit = part.length > 1 && previous.to < last.from &&
      (!!previous.children || ["Number", "String"].includes(previous.type) || word(previous) === "END" || nameToken(previous));
    const alias = nameToken(last) && (explicit || implicit) ? last : undefined;
    const exprEnd = part.length - (alias ? explicit ? 2 : 1 : 0);
    const path = pathEndingAt(part, exprEnd);
    const simple = path?.start === 0 ? path : undefined;
    const name = alias ?? simple?.name;
    const metadata = simple && resolveField(simple, levels, kind);
    columns.push(name ? { dataType: "", nullable: false, ...metadata, name: actualName(name, kind) } : undefined);
  }
  return columns;
}

function queryOutput(tokens: Token[], ctes: Cte[], catalog: CatalogLookup, outer: Source[][], budget: number) {
  if (budget <= 0) return undefined;
  return selectColumns(queryScope(tokens, ctes, catalog, outer, -1, budget), catalog.kind);
}

function nestedQuery(tokens: Token[], pos: number): Token | undefined {
  let level = tokens;
  while (true) {
    const group = level.find((token) => within(token, pos));
    if (!group?.children) return;
    if (isSelect(group.children)) return group;
    level = group.children;
  }
}

export function queryScope(tokens: Token[], inherited: Cte[], catalog: CatalogLookup, outer: Source[][], pos: number, budget = 48): Scope {
  if (budget <= 0) return { tokens: [], ctes: inherited, sources: [], outer: [] };
  const { definitions, body, recursive } = withDefinitions(tokens);
  let ctes = inherited;
  for (const { name, names, query } of definitions) {
    const earlier = ctes;
    const resolve = (scope: Cte[]) => queryOutput(query.children!, scope, catalog, [], budget - 1);
    const anchor = { name, columns: memo(() => names.length
      ? renameColumns(names, resolve(earlier), catalog.kind)
      : resolve(earlier)?.filter((item): item is CompletionColumn => !!item)) };
    const visible = recursive ? [anchor, ...earlier] : earlier;
    if (within(query, pos)) return queryScope(query.children!, visible, catalog, [], pos, budget - 1);
    ctes = [{ name, columns: memo(() => {
      const items = resolve(visible);
      return names.length
        ? renameColumns(names, items, catalog.kind)
        : items?.filter((item): item is CompletionColumn => !!item);
    }) }, ...earlier];
  }
  const arm = queryArm(body, pos);
  const sources = tableRefs(arm, ctes, catalog, outer, budget);
  const nested = nestedQuery(arm, pos);
  if (nested) {
    const sourceIndex = sources.findIndex((ref) => ref.group === nested);
    const visible = sourceIndex < 0 ? [sources, ...outer]
      : sources[sourceIndex].lateral ? [sources.slice(0, sourceIndex), ...outer] : [];
    return queryScope(nested.children!, ctes, catalog, visible, pos, budget - 1);
  }
  return { tokens: arm, ctes, sources, outer };
}
