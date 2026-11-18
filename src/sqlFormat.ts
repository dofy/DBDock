import { MySQL, PostgreSQL, SQLite, SQLDialect } from "@codemirror/lang-sql";
import { formatDialect, mysql, postgresql, sqlite, type DialectOptions } from "sql-formatter";
import type { Kind } from "./api";

const mysqlLexer = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true });

type FormatterTokens = Parameters<NonNullable<DialectOptions["tokenizerOptions"]["postProcess"]>>[0];
const bareName = /^[A-Za-z_][A-Za-z_0-9$]*$/;
const syntaxWords = new Set([
  "ALL", "DISTINCT", "DISTINCTROW", "FALSE", "NULL", "TRUE", "DEFAULT",
  "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "LOCALTIME", "LOCALTIMESTAMP",
  "RECURSIVE", "MATERIALIZED", "LATERAL", "ONLY", "TABLESAMPLE", "REPEATABLE",
  "OVER", "FILTER", "PARTITION", "ROWS", "RANGE", "GROUPS", "WINDOW",
  "CURRENT", "ROW", "PRECEDING", "FOLLOWING", "UNBOUNDED", "TIES", "OTHERS", "EXCLUDE", "FIRST", "LAST",
  "LEADING", "TRAILING", "BOTH", "PLACING", "SEPARATOR", "ORDINALITY",
  "ASC", "DESC", "NULLS", "ZONE", "DIV", "MOD", "REGEXP", "RLIKE", "GLOB", "MATCH", "ROLLUP", "CUBE",
  "ISNULL", "NOTNULL", "SIMILAR", "AT", "TIME", "STRAIGHT_JOIN",
  "SKIP", "LOCKED", "NOWAIT", "WAIT", "SHARE", "NO",
]);
const specialArguments = new Set(["EXTRACT", "JSON_TABLE", "XMLTABLE", "XMLELEMENT", "XMLSERIALIZE"]);
const tableCommand = /^(?:(?:INSERT|REPLACE)(?: .+)? INTO|(?:DELETE )?FROM(?: ONLY)?|UPDATE(?: ONLY)?|CREATE(?: (?:TEMP|TEMPORARY|UNLOGGED))? TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: IF EXISTS)?|DROP TABLE(?: IF EXISTS)?|TRUNCATE TABLE|REFERENCES)$/;
const mysqlPredicates = /^(?:IS(?: NOT)?(?: NULL)?|LIKE|NOT LIKE|BETWEEN|NOT BETWEEN|REGEXP|RLIKE)$/;

function quotedName(name: string, kind: Kind): string {
  // PostgreSQL folds bare ASCII identifiers before resolving them.
  if (kind === "postgres") return `"${name.toLowerCase()}"`;
  return kind === "mysql" ? `\`${name}\`` : `"${name}"`;
}

function quoteReferences(tokens: FormatterTokens, kind: Kind): FormatterTokens {
  const code = tokens.filter((token) => !token.type.endsWith("COMMENT"));
  const replacements = new Map<number, string>();
  const parens: string[] = [];
  let statement = "";
  let query = false;
  let createTable = false;
  let alterTable = false;
  let ddl = false;
  let createColumnsAt = -1;
  let first = true;
  for (let i = 0; i < code.length; i++) {
    const token = code[i];
    const word = token.text.toUpperCase();
    const previous = code[i - 1]?.text.toUpperCase();
    if (token.type === "DELIMITER") {
      first = true;
      parens.length = 0;
      createColumnsAt = -1;
      continue;
    }
    if (first) {
      statement = word;
      query = /^(SELECT|WITH|INSERT|REPLACE|UPDATE|DELETE|WHERE|FROM|JOIN|GROUP BY|ORDER BY|RETURNING)\b/.test(word);
      createTable = /^CREATE(?: (?:TEMP|TEMPORARY|UNLOGGED))? TABLE\b/.test(word);
      alterTable = /^ALTER TABLE\b/.test(word);
      ddl = createTable || alterTable || /^(DROP|TRUNCATE) TABLE\b/.test(word);
      first = false;
    }
    if (!query && !ddl) continue;
    if (token.text === "(") {
      parens.push(token.start === createColumnsAt ? "CREATE TABLE" : previous ?? "");
      continue;
    }
    if (token.text === ")") {
      parens.pop();
      continue;
    }
    // A dotted path is one unit: a function or type can have a schema prefix.
    if (previous === "." || (!bareName.test(token.raw) && token.type !== "QUOTED_IDENTIFIER")) continue;
    let end = i;
    while (code[end + 1]?.text === "." && code[end + 2] &&
      (bareName.test(code[end + 2].raw) || code[end + 2].type === "QUOTED_IDENTIFIER")) end += 2;
    const next = code[end + 1];
    const tablePosition = tableCommand.test(previous ?? "") || code[i - 1]?.type === "RESERVED_JOIN";
    const allowsColumnList = tablePosition && /^(INSERT|REPLACE|CREATE|REFERENCES)\b/.test(previous ?? "");
    if (createTable && previous === statement && next?.text === "(") createColumnsAt = next.start;
    const columnDefinition = parens.length === 1 && parens[0] === "CREATE TABLE" && (previous === "(" || previous === ",");
    const alterName = alterTable && (previous === "TO" || /^(ADD|DROP|RENAME|ALTER) COLUMN$/.test(previous ?? ""));
    const functionName = parens[parens.length - 1] ?? "";
    const skip = (next?.text === "(" && !allowsColumnList) || next?.type === "STRING" ||
      previous === "::" || previous === ":" || previous === "COLLATE" ||
      (previous === "AS" && /^(?:TRY_)?CAST$/.test(functionName)) ||
      (previous === "USING" && functionName === "CONVERT") ||
      parens.some((name) => specialArguments.has(name));
    if (!skip && (query || tablePosition || columnDefinition || alterName)) {
      for (let j = i; j <= end; j += 2) {
        const name = code[j];
        if (bareName.test(name.raw) && !syntaxWords.has(name.text.toUpperCase()) &&
          (name.type === "IDENTIFIER" || j > i || tablePosition && /^(?:RESERVED_(?:DATA_TYPE|FUNCTION_NAME))$/.test(name.type))) {
          replacements.set(name.start, quotedName(name.raw, kind));
        }
      }
    }
    i = end;
  }
  return tokens.map((token) => {
    const quote = replacements.get(token.start);
    if (quote) return { ...token, text: quote, raw: quote, type: "QUOTED_IDENTIFIER" as typeof token.type };
    // The formatter treats these MySQL predicates as functions and skips their keyword casing.
    if (kind === "mysql" && token.type === "RESERVED_FUNCTION_NAME" && mysqlPredicates.test(token.text.toUpperCase())) {
      return { ...token, raw: token.raw.toUpperCase() };
    }
    return token;
  });
}

function beautyDialect(dialect: DialectOptions, kind: Kind): DialectOptions {
  const settings = dialect.tokenizerOptions;
  return {
    ...dialect,
    tokenizerOptions: {
      ...settings,
      postProcess: (tokens) => quoteReferences(settings.postProcess?.(tokens) ?? tokens, kind),
    },
  };
}

const beautyMysql = beautyDialect(mysql, "mysql");
const beautyPostgres = beautyDialect(postgresql, "postgres");
const beautySqlite = beautyDialect(sqlite, "sqlite");

interface SqlToken {
  name: string;
  from: number;
  to: number;
  text: string;
}

function tokens(sql: string, dialect: SQLDialect): SqlToken[] {
  const result: SqlToken[] = [];
  const cursor = dialect.language.parser.parse(sql).cursor();
  cursor.iterate((node) => {
    const quotedIdentifier = dialect === SQLite && node.name === "Brackets";
    if (node.to > node.from && (quotedIdentifier || !node.node.firstChild)) {
      result.push({ name: node.name, from: node.from, to: node.to, text: sql.slice(node.from, node.to) });
      return false;
    }
  });
  return result;
}

interface SqlFormatEdit {
  from: number;
  to: number;
  text: string;
  anchor: number;
  head: number;
}

/** Format a selected range or the whole editor while keeping the caret on the same token. */
export function formatSqlEdit(doc: string, anchor: number, head: number, kind: Kind): SqlFormatEdit | null {
  const selected = anchor !== head;
  const from = selected ? Math.min(anchor, head) : 0;
  const to = selected ? Math.max(anchor, head) : doc.length;
  const source = doc.slice(from, to);
  if (!source.trim()) return null;

  const [dialect, lexer] = kind === "mysql" ? [beautyMysql, mysqlLexer] : kind === "postgres" ? [beautyPostgres, PostgreSQL] : [beautySqlite, SQLite];
  const formatted = formatDialect(source, { dialect, tabWidth: 2, keywordCase: "upper" });
  // Keep whitespace at selection edges, especially the newline after a line comment.
  let text = selected ? source.slice(0, source.length - source.trimStart().length) + formatted
    + source.slice(source.trimEnd().length) : formatted;
  if (source === text) return null;

  const candidate = doc.slice(0, from) + text + doc.slice(to);
  const before = tokens(doc, lexer);
  let after = tokens(candidate, lexer);
  const comments: { from: number; to: number; text: string }[] = [];
  const stripCommentIndent = (comment: string) => comment.replace(/\n[ \t]*/g, "\n");
  if (before.length !== after.length || before.some((token, index) => {
    const next = after[index];
    const within = token.from >= from && token.to <= to;
    const isBareName = bareName.test(token.text);
    const addedQuotes = within && isBareName && next.name === "QuotedIdentifier" && next.text === quotedName(token.text, kind);
    const keywordCase = within && isBareName && next.text === token.text.toUpperCase();
    if (token.name !== next.name && !addedQuotes) return true;
    if (token.text !== next.text && !addedQuotes && !keywordCase) {
      if (token.name !== "BlockComment" || next.from < from || next.to > from + text.length ||
          stripCommentIndent(token.text) !== stripCommentIndent(next.text)) return true;
      // Keep comment text verbatim even when the formatter adjusts its indentation.
      comments.push({ from: next.from - from, to: next.to - from, text: token.text });
    }
    const previous = before[index - 1];
    if (!previous) return false;
    const oldGap = doc.slice(previous.to, token.from);
    const newGap = candidate.slice(after[index - 1].to, next.from);
    // PostgreSQL can concatenate adjacent string literals across a newline.
    if (kind === "postgres" && previous.name === "String" && token.name === "String") {
      return /[\r\n]/.test(oldGap) !== /[\r\n]/.test(newGap);
    }
    // In MySQL, the space before a built-in function's opening paren can affect resolution.
    if (kind === "mysql" && token.name === "(" && bareName.test(previous.text) && after[index - 1].name !== "QuotedIdentifier" &&
      !/^(?:IN|VALUES|EXISTS|OVER|PARTITION|KEY|CHECK|INDEX|USING|UNIQUE)$/i.test(previous.text)) {
      return !!oldGap !== !!newGap;
    }
    return false;
  })) throw new Error("SQL formatter changed the token stream");

  for (const comment of comments.reverse()) {
    text = text.slice(0, comment.from) + comment.text + text.slice(comment.to);
  }
  if (comments.length && !selected) after = tokens(text, lexer);
  if (source === text) return null;

  if (selected) {
    const end = from + text.length;
    return { from, to, text, anchor: anchor < head ? from : end, head: anchor < head ? end : from };
  }

  let tokenIndex = before.findIndex((token) => head < token.to);
  // At a shared boundary, prefer the token beginning at the caret (for example, ;SELECT).
  if (tokenIndex > 0 && head < before[tokenIndex].from && head === before[tokenIndex - 1].to) tokenIndex--;
  if (tokenIndex < 0) return { from, to, text, anchor: text.length, head: text.length };
  const beforeToken = before[tokenIndex];
  const afterToken = after[tokenIndex];
  const quoteOffset = afterToken.name === "QuotedIdentifier" && beforeToken.name !== "QuotedIdentifier" && head >= beforeToken.from ? 1 : 0;
  const cursor = afterToken.from + Math.max(0, head - beforeToken.from) + quoteOffset;
  return { from, to, text, anchor: cursor, head: cursor };
}
