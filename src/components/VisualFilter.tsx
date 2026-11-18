import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { FilterCondition, FilterOperator, TableFilter } from "../api";
import { t } from "../i18n";

const OPERATORS: [FilterOperator, string][] = [
  ["equals", "="], ["notEquals", "≠"], ["greater", ">"], ["less", "<"],
  ["contains", "Contains"], ["isNull", "IS NULL"], ["isNotNull", "IS NOT NULL"],
];

export function describeVisualFilter(filter: TableFilter) {
  const join = t(filter.matchAny ? "OR" : "AND");
  return filter.conditions.map(({ column, operator, value }) => {
    const label = t(OPERATORS.find(([op]) => op === operator)?.[1] ?? operator);
    return operator === "isNull" || operator === "isNotNull"
      ? `${column} ${label}`
      : `${column} ${label} ${JSON.stringify(value)}`;
  }).join(` ${join} `);
}

export function VisualFilter({ columns, applied, onApply, onClose }: {
  columns: string[];
  applied?: TableFilter;
  onApply: (filter: TableFilter | undefined) => void;
  onClose: () => void;
}) {
  const blank = (): FilterCondition => ({ column: columns[0] ?? "", operator: "equals", value: "" });
  const [rows, setRows] = useState<FilterCondition[]>(applied?.conditions ?? [blank()]);
  const [matchAny, setMatchAny] = useState(applied?.matchAny ?? false);
  const edit = (index: number, patch: Partial<FilterCondition>) =>
    setRows((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row));

  return (
    <form className="visual-filter" onSubmit={(e) => {
      e.preventDefault();
      onApply(rows.length ? { matchAny, conditions: rows } : undefined);
    }}>
      <div className="row">
        <select aria-label={t("Match conditions")} value={matchAny ? "any" : "all"} onChange={(e) => setMatchAny(e.target.value === "any")}>
          <option value="all">{t("Match all (AND)")}</option>
          <option value="any">{t("Match any (OR)")}</option>
        </select>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("Close")}><X size={14} /></button>
      </div>
      <div className="filter-conditions">
        {rows.map((row, index) => (
          <div className="filter-condition" key={index}>
            <select aria-label={t("Column")} value={row.column} onChange={(e) => edit(index, { column: e.target.value })}>
              {columns.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select aria-label={t("Operator")} value={row.operator} onChange={(e) => edit(index, { operator: e.target.value as FilterOperator })}>
              {OPERATORS.map(([op, label]) => <option key={op} value={op}>{t(label)}</option>)}
            </select>
            <input aria-label={t("Value")} placeholder={t("Value")} value={row.value} disabled={row.operator === "isNull" || row.operator === "isNotNull"} onChange={(e) => edit(index, { value: e.target.value })} />
            <button type="button" className="icon-btn" aria-label={t("Remove condition")} onClick={() => setRows((current) => current.filter((_, i) => i !== index))}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div className="row">
        <button type="button" disabled={rows.length >= 20} onClick={() => setRows((current) => [...current, blank()])}><Plus size={14} />{t("Add condition")}</button>
        <span className="spacer" />
        <button type="button" onClick={() => onApply(undefined)}>{t("Clear filters")}</button>
        <button className="primary" type="submit" disabled={rows.some((row) => !columns.includes(row.column))}>{t("Apply filters")}</button>
      </div>
    </form>
  );
}
