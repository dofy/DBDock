import type { Cell } from "./api";

export interface TableFile {
  columns: string[];
  rows: Cell[][];
}

const MAX_ROWS = 5000;
const MAX_COLUMNS = 2000;

function checked(columns: unknown[], rows: Cell[][]): TableFile {
  if (!columns.length || columns.length > MAX_COLUMNS || columns.some((c) => typeof c !== "string" || !c.trim())) {
    throw new Error("The import file needs named columns");
  }
  if (new Set(columns).size !== columns.length) throw new Error("The import file contains duplicate columns");
  if (!rows.length || rows.length > MAX_ROWS) throw new Error("The import file must contain 1 to 5,000 data rows");
  if (rows.some((r) => r.length !== columns.length)) throw new Error("Every import row must have the same number of columns");
  return { columns: columns as string[], rows };
}

function parseCsv(text: string): TableFile {
  const records: Cell[][] = [];
  let row: Cell[] = [];
  let value = "";
  let state: "start" | "plain" | "quoted" | "closed" = "start";

  const field = () => {
    row.push(state === "start" ? null : value);
    if (row.length > MAX_COLUMNS) throw new Error("Too many import columns");
    value = "";
    state = "start";
  };
  const record = () => {
    field();
    records.push(row);
    if (records.length > MAX_ROWS + 1) throw new Error("The import file must contain 1 to 5,000 data rows");
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === "quoted") {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') state = "closed";
      else value += c;
    } else if (c === ",") {
      field();
    } else if (c === "\r" || c === "\n") {
      record();
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else if (state === "start" && c === '"') {
      state = "quoted";
    } else {
      if (state === "closed" || c === '"') throw new Error("Invalid CSV quoting");
      state = "plain";
      value += c;
    }
  }
  if ((state as string) === "quoted") throw new Error("Unclosed quoted CSV value");
  if (row.length || (state as string) !== "start") record();
  const [columns = [], ...rows] = records;
  return checked(columns, rows);
}

function jsonCell(value: unknown): Cell {
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("Use JSON strings for numbers outside JavaScript's safe integer range");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "number") jsonCell(nested);
    return nested;
  });
}

function parseJson(text: string): TableFile {
  const value = JSON.parse(text) as unknown;
  if (Array.isArray(value)) {
    if (value.length > MAX_ROWS) throw new Error("The import file must contain 1 to 5,000 data rows");
    const records = value as Record<string, unknown>[];
    if (records.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("JSON import expects an array of objects or a columns-and-rows export");
    }
    const columns = Object.keys(records[0] ?? {});
    const rows = records.map((row) => {
      if (Object.keys(row).length !== columns.length || columns.some((c) => !Object.prototype.hasOwnProperty.call(row, c))) {
        throw new Error("JSON objects must have the same fields");
      }
      return columns.map((c) => jsonCell(row[c]));
    });
    return checked(columns, rows);
  }
  const matrix = value as { columns?: unknown[]; rows?: unknown[][] } | null;
  if (!Array.isArray(matrix?.columns) || !Array.isArray(matrix?.rows) || matrix.rows.length > MAX_ROWS || matrix.rows.some((row) => !Array.isArray(row))) {
    throw new Error("JSON import expects an array of objects or a columns-and-rows export");
  }
  return checked(matrix.columns, matrix.rows.map((row) => row.map(jsonCell)));
}

export function parseTableFile(text: string, format: "csv" | "json"): TableFile {
  const contents = text.replace(/^\uFEFF/, "");
  return format === "csv" ? parseCsv(contents) : parseJson(contents);
}
