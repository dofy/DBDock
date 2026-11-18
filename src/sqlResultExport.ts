import type { QueryResult } from "./api";

export type ExportFormat = "csv" | "json";

export function serializeResult(result: Pick<QueryResult, "columns" | "rows">, format: ExportFormat): string {
  const { columns, rows } = result;
  if (format === "json") {
    // Positional rows retain values even when two result columns share a name.
    return JSON.stringify({ columns, rows }, null, 2) + "\n";
  }
  const csvCell = (cell: string | number | boolean | null) => {
    if (cell === null) return "";
    let value = String(cell);
    // Spreadsheet applications may interpret these text cells as formulas.
    if (typeof cell === "string" && /^(?:[\t\r\n]|\s*[=+@-])/.test(cell)) value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  };
  return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
