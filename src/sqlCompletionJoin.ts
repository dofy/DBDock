import type { Completion } from "@codemirror/autocomplete";
import type { CompletionForeignKey, Kind } from "./api";
import { quote, sameReference, type Source } from "./sqlCompletionScope.ts";

export type ReadForeignKeys = (schema: string, table: string) => CompletionForeignKey[] | undefined;

function qualifier(source: Source, peers: Source[], kind: Kind) {
  const { name, schema } = source;
  if (!name) return;
  const duplicates = peers.filter((peer) => peer.name && sameReference(name, peer.name, kind));
  if (duplicates.length === 1) return name.text;
  if (schema && duplicates.every((peer) => peer === source || (peer.schema && !sameReference(schema, peer.schema, kind)))) {
    return schema.text + "." + name.text;
  }
}

function columnName(source: Source, field: string, kind: Kind) {
  const columns = source.baseTable()?.columns;
  const i = columns?.findIndex(({ name }) => kind === "postgres" ? name === field : name.toLowerCase() === field.toLowerCase());
  return i === undefined || i < 0 ? undefined : source.columns()?.[i]?.name;
}

export function joinOptions(sources: Source[], on: number, kind: Kind, readForeignKeys: ReadForeignKeys): Completion[] {
  const preceding = sources.filter((source) => source.at < on);
  const joined = preceding.pop();
  const target = joined?.baseTable();
  if (!joined || joined.introducer !== "JOIN" || !target) return [];

  // An ON expression may use the joined relation and its left-hand join chain.
  const comma = preceding.map((source) => source.introducer).lastIndexOf(",");
  const left = preceding.slice(Math.max(comma, 0));
  const peers = [...left, joined];
  const expressions = new Map<string, Completion>();
  const matching = (name: string, actual: string) =>
    kind === "sqlite" || kind === "d1" ? name.toLowerCase() === actual.toLowerCase() : name === actual;
  const add = (child: Source, parent: Source) => {
    const from = child.baseTable();
    const to = parent.baseTable();
    const childName = qualifier(child, peers, kind);
    const parentName = qualifier(parent, peers, kind);
    if (!from || !to || !childName || !parentName) return;
    for (const key of readForeignKeys(from.schema, from.table) ?? []) {
      if (!matching(key.referencedSchema, to.schema) || !matching(key.referencedTable, to.table)) continue;
      const pairs = key.columns.map(({ column, referencedColumn }) => {
        const a = columnName(child, column, kind);
        const b = columnName(parent, referencedColumn, kind);
        return a && b ? childName + "." + quote(a, kind) + " = " + parentName + "." + quote(b, kind) : undefined;
      });
      if (!pairs.length || pairs.some((pair) => !pair)) continue;
      const condition = pairs.join(" AND ");
      expressions.set(condition, {
        label: condition, type: "keyword", boost: 20, detail: kind === "sqlite" || kind === "d1" ? "FOREIGN KEY" : key.name,
      });
    }
  };
  for (const peer of left) {
    add(joined, peer);
    add(peer, joined);
  }
  return [...expressions.values()];
}
