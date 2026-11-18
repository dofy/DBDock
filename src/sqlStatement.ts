import { MySQL, PostgreSQL, SQLite, SQLDialect } from "@codemirror/lang-sql";
import type { Kind } from "./api";

const mysqlEscaped = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true });
const postgresEscaped = SQLDialect.define({ ...PostgreSQL.spec, backslashEscapes: true });

type Range = { from: number; to: number };
type Selection = { status: "sql"; text: string } | { status: "empty" | "ambiguous" };

function statements(doc: string, dialect: SQLDialect, kind: Kind): Range[] | null {
  const ranges: Range[] = [];
  const tree = dialect.language.parser.parse(doc);
  let ambiguousComment = false;
  if (kind !== "postgres") {
    tree.iterate({ enter(node) {
      if (node.name !== "BlockComment") return;
      const comment = doc.slice(node.from, node.to);
      // The highlighter accepts nested comments, but SQLite and MySQL end at the first closing marker.
      if (comment.indexOf("/*", 2) >= 0 || (kind === "mysql" && /^\/\*(?:!|M!)/i.test(comment))) ambiguousComment = true;
    } });
  }
  if (ambiguousComment) return null;
  const cursor = tree.cursor();
  for (let more = cursor.firstChild(); more; more = cursor.nextSibling()) {
    const from = cursor.from;
    const to = cursor.to;
    if (cursor.name !== "Statement") continue;

    // The editor grammar highlights these bodies but does not parse their internal boundaries.
    const words: string[] = [];
    let hasSql = false;
    if (cursor.firstChild()) {
      do {
        const token = cursor.type.name;
        if (token === "LineComment" || token === "BlockComment" || token === ";") continue;
        hasSql = true;
        words.push(token === "Keyword" || token === "Identifier" ? doc.slice(cursor.from, cursor.to).toUpperCase() : "");
      } while (cursor.nextSibling());
      cursor.parent();
    }

    const command = words.join(" ");
    if (kind === "mysql" && /^(?:DELIMITER\b|CREATE\b.*\b(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b.*\bBEGIN\b|BEGIN\s+NOT\s+ATOMIC\b)/.test(command)) return null;
    if (kind === "postgres" && /^(?:CREATE\b.*\bBEGIN\s+ATOMIC\b|CREATE\s+(?:OR\s+REPLACE\s+)?RULE\b|COPY\b.*\bFROM\s+STDIN\b)/.test(command)) return null;
    if ((kind === "sqlite" || kind === "d1") && /^(?:EXPLAIN (?:QUERY PLAN )?)?CREATE (?:TEMP(?:ORARY)? )?TRIGGER\b/.test(command)) {
      // SQLite ends a trigger body with a standalone END following its last inner semicolon.
      let end = -1;
      while (cursor.nextSibling()) {
        if (cursor.name !== "Statement") continue;
        const tokens = [];
        for (let token = cursor.node.firstChild; token; token = token.nextSibling) {
          if (token.name !== "LineComment" && token.name !== "BlockComment" && token.name !== ";") tokens.push(token);
        }
        if (tokens.length === 1 && /^END$/i.test(doc.slice(tokens[0].from, tokens[0].to))) {
          end = cursor.to;
          break;
        }
      }
      if (end < 0) return null;
      ranges.push({ from, to: end });
      continue;
    }
    if (hasSql) ranges.push({ from, to });
  }
  return ranges;
}

function atCursor(doc: string, ranges: Range[], position: number): Range | undefined {
  let previous: Range | undefined;
  const inPadding = position === doc.length || /[\t \r\n]/.test(doc[position]);
  for (const range of ranges) {
    if (range.from <= position && position < range.to) return range;
    if (position < range.from) {
      if (!inPadding) return undefined;
      // A caret in indentation starts the next statement, while same-line padding after a statement belongs to the previous one.
      if (previous && /^[\t ]*$/.test(doc.slice(previous.to, position))) return previous;
      return /^[\t ]*$/.test(doc.slice(position, range.from)) ? range : undefined;
    }
    previous = range;
  }
  return inPadding && previous && /^[\t ]*$/.test(doc.slice(previous.to, position)) ? previous : undefined;
}

/** An explicit selection wins. Otherwise send only the bounded statement at the caret. */
export function selectedOrCurrentStatement(doc: string, from: number, to: number, kind: Kind): Selection {
  if (from !== to) {
    const text = doc.slice(from, to).trim();
    return text ? { status: "sql", text } : { status: "empty" };
  }
  // MySQL accepts a control character after --, while the editor expects a space.
  if (kind === "mysql" && /--[\x00-\x1f\x7f]/.test(doc)) return { status: "ambiguous" };
  if (kind === "postgres" && /\$[a-z_0-9\u0080-\uffff]*[\u0080-\uffff][a-z_0-9\u0080-\uffff]*\$/i.test(doc)) {
    // PostgreSQL accepts non-ASCII dollar tags that the editor grammar does not recognize.
    return { status: "ambiguous" };
  }
  const dialect = kind === "mysql" ? MySQL : kind === "postgres" ? PostgreSQL : SQLite;
  const ranges = statements(doc, dialect, kind);
  if (!ranges) return { status: "ambiguous" };
  const current = atCursor(doc, ranges, from);
  if (doc.includes("\\") && (kind === "mysql" || kind === "postgres")) {
    // The two session escape modes must agree before we infer an execution boundary.
    const escaped = statements(doc, kind === "mysql" ? mysqlEscaped : postgresEscaped, kind);
    const alternative = escaped && atCursor(doc, escaped, from);
    if (escaped === null || alternative?.from !== current?.from || alternative?.to !== current?.to) return { status: "ambiguous" };
  }
  return current ? { status: "sql", text: doc.slice(current.from, current.to) } : { status: "empty" };
}
