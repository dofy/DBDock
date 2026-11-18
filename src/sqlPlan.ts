import type { ExecutionPlan, QueryResult } from "./api";

type Fields = Record<string, unknown>;

export interface PlanNode {
  name: string;
  target?: string;
  estimatedRows?: number;
  actualRows?: number;
  loops?: number;
  timeMs?: number;
  details: [string, string][];
  children: PlanNode[];
}

interface PlanModel {
  nodes: PlanNode[];
  raw: string;
  planningMs?: number;
  executionMs?: number;
}

const record = (value: unknown): Fields | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown) => typeof value === "string" ? value : undefined;
function number(value: unknown) {
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function details(fields: Fields, keys: string[]): PlanNode["details"] {
  return keys.flatMap((key) => {
    const value = fields[key];
    return value === undefined || value === null ? [] : [[key, Array.isArray(value) ? value.join(", ") : String(value)]];
  });
}

function postgres(value: unknown, depth = 0): PlanNode | undefined {
  const fields = record(value);
  const name = string(fields?.["Node Type"]);
  if (!fields || !name || depth > 80) return;
  const target = ["Schema", "Relation Name"].map((key) => string(fields[key])).filter(Boolean).join(".");
  return {
    name,
    target: target || string(fields["CTE Name"]),
    estimatedRows: number(fields["Plan Rows"]),
    actualRows: number(fields["Actual Rows"]),
    loops: number(fields["Actual Loops"]),
    timeMs: number(fields["Actual Total Time"]),
    details: details(fields, [
      "Join Type", "Parent Relationship", "Subplan Name", "Alias", "Index Name", "Index Cond", "Filter", "Hash Cond",
      "Merge Cond", "Join Filter", "Recheck Cond", "Sort Key", "Group Key", "Total Cost", "Rows Removed by Filter",
      "Shared Hit Blocks", "Shared Read Blocks", "Temp Read Blocks", "Temp Written Blocks",
    ]),
    children: list(fields.Plans).flatMap((child) => postgres(child, depth + 1) ?? []),
  };
}

const mysqlOperators: Record<string, string> = {
  query_block: "Query block", nested_loop: "Nested loop", ordering_operation: "Sort",
  grouping_operation: "Group", duplicates_removal: "Remove duplicates", union_result: "Union",
  materialized_from_subquery: "Materialize", windowing: "Window",
};

function mysqlJson(value: unknown, key = "", depth = 0): PlanNode[] {
  if (depth > 80) return [];
  if (Array.isArray(value)) {
    const children = value.flatMap((item) => mysqlJson(item, "", depth + 1));
    return children.length && mysqlOperators[key] ? [{ name: mysqlOperators[key], details: [], children }] : children;
  }
  const fields = record(value);
  if (!fields) return [];
  const children = Object.entries(fields).flatMap(([field, child]) => mysqlJson(child, field, depth + 1));
  const target = string(fields.table_name);
  const access = string(fields.access_type);
  const name = string(fields.operation) ?? (target ? (access === "ALL" ? "Table scan" :
    access === "index" ? "Index scan" : fields.key ? "Index lookup" : "Table access") : mysqlOperators[key]);
  if (!name && !string(fields.message)) return children;
  return [{
    name: name ?? String(fields.message),
    target,
    estimatedRows: number(fields.estimated_rows ?? fields.rows_produced_per_join ?? fields.rows_examined_per_scan),
    details: details(fields, ["access_type", "key", "possible_keys", "used_key_parts", "attached_condition", "using_filesort", "using_temporary_table", "estimated_total_cost"]),
    children,
  }];
}

function mysqlTree(raw: string): PlanNode[] {
  const root: PlanNode[] = [];
  const stack: { depth: number; node: PlanNode }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const offset = line.match(/^(\s*)-> /)?.[1].length;
    const last = stack[stack.length - 1];
    if (offset === undefined) {
      if (last && line.trim()) last.node.details.push(["", line.trim()]);
      continue;
    }
    const text = line.slice(offset + 3).trim();
    const metrics = text.search(/\s+\((?:cost=|actual time=|never executed)/);
    const tail = metrics < 0 ? "" : text.slice(metrics);
    const runtime = tail.match(/\(actual time=([\d.eE+-]+)\.\.([\d.eE+-]+) rows=([\d.eE+-]+) loops=(\d+)\)/);
    const estimate = tail.match(/\(cost=[^)]* rows=([\d.eE+-]+)\)/);
    const node: PlanNode = {
      name: metrics < 0 ? text : text.slice(0, metrics),
      estimatedRows: number(estimate?.[1]),
      actualRows: number(runtime?.[3]),
      loops: number(runtime?.[4]),
      timeMs: number(runtime?.[2]),
      details: tail ? [["", tail.trim()]] : [],
      children: [],
    };
    while (stack.length && stack[stack.length - 1].depth >= offset) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    (parent?.children ?? root).push(node);
    stack.push({ depth: offset, node });
  }
  return root;
}

function sqlite(result: QueryResult): PlanNode[] {
  const id = result.columns.findIndex((column) => column.toLowerCase() === "id");
  const parent = result.columns.findIndex((column) => column.toLowerCase() === "parent");
  const detail = result.columns.findIndex((column) => column.toLowerCase() === "detail");
  if (id < 0 || parent < 0 || detail < 0) return [];
  const records = new Map<number, { parent: number; node: PlanNode }>();
  for (const row of result.rows) {
    const identifier = number(row[id]);
    const name = string(row[detail]);
    if (identifier === undefined || !name) continue;
    records.set(identifier, { parent: number(row[parent]) ?? -1, node: { name, details: [], children: [] } });
  }
  const root: PlanNode[] = [];
  for (const [identifier, entry] of records) {
    const above = records.get(entry.parent);
    // SQLite's root sentinel is 0. Guard unknown parents and malformed cycles.
    let current = above;
    const visited = new Set([identifier]);
    while (current && !visited.has(current.parent)) {
      visited.add(current.parent);
      current = records.get(current.parent);
    }
    (above && !current && entry.parent !== 0 ? above.node.children : root).push(entry.node);
  }
  return root;
}

export function readExecutionPlan(plan: ExecutionPlan): PlanModel {
  const { format, result } = plan;
  if (format === "sqliteTree") return { nodes: sqlite(result), raw: JSON.stringify({ columns: result.columns, rows: result.rows }, null, 2) };
  const raw = result.rows.map((row) => string(row[0]) ?? "").filter(Boolean).join("\n");
  if (format === "mysqlTree") return { nodes: mysqlTree(raw), raw };
  try {
    const value: unknown = JSON.parse(raw);
    const pretty = JSON.stringify(value, null, 2);
    if (format === "mysqlJson") return { nodes: mysqlJson(value), raw: pretty };
    const top = record(list(value)[0]);
    const root = postgres(top?.Plan);
    return {
      nodes: root ? [root] : [],
      planningMs: number(top?.["Planning Time"]),
      executionMs: number(top?.["Execution Time"]),
      raw: pretty,
    };
  } catch {
    return { nodes: [], raw };
  }
}
