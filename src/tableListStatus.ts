export type LoadStatus = "loading" | "ready" | "error";

/** Derive the visible empty state without treating pending or failed requests as empty. */
export function tableListStatus(
  schema: string,
  schemasStatus: LoadStatus,
  tableSchema: string,
  tablesStatus: LoadStatus,
  tableCount: number,
  shownCount: number,
): "loading" | "error" | "no-schemas" | "no-tables" | "no-matches" | "ready" {
  if (!schema) return schemasStatus === "loading" ? "loading" : schemasStatus === "error" ? "error" : "no-schemas";
  if (schema !== tableSchema || tablesStatus === "loading") return "loading";
  if (tablesStatus === "error") return "error";
  if (!tableCount) return "no-tables";
  return shownCount ? "ready" : "no-matches";
}
