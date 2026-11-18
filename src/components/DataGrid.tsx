import { t, tf } from "../i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Cell, QueryResult } from "../api";
import { Copy } from "lucide-react";
import emptyResultsArt from "../assets/empty-results.webp";

export type RowState = "deleted" | "inserted" | undefined;

export interface GridEditing {
  canEdit: (col: number) => boolean;
  /** Pending value overriding the stored one, if any. */
  pending: (row: number, col: number) => Cell | undefined;
  rowState: (row: number) => RowState;
  onChange: (row: number, col: number, value: Cell) => void;
}

export interface Selection {
  r: number;
  c: number;
}

interface Props {
  result: QueryResult;
  /** Column names to show when the result has no rows (and so no columns). */
  fallbackColumns?: string[];
  orderBy?: string;
  orderDesc?: boolean;
  onSort?: (column: string) => void;
  rowOffset?: number;
  editing?: GridEditing;
  onSelect?: (sel: Selection | null) => void;
  /** Selection resets when this changes (defaults to `result`). */
  resetKey?: unknown;
  emptyState?: ReactNode;
}

export function ResultEmpty({ title, detail, action, illustrated }: {
  title: string;
  detail?: string;
  action?: ReactNode;
  illustrated?: boolean;
}) {
  return <div className={illustrated ? "grid-empty result-empty result-empty--illustrated" : "grid-empty result-empty"}>
    {illustrated && <img className="result-empty-illustration" src={emptyResultsArt} alt="" width={384} height={347} />}
    <div role="status">
      <strong>{title}</strong>
      {detail && <p className="muted">{detail}</p>}
    </div>
    {action}
  </div>;
}

function show(v: Cell | undefined): string {
  if (v === undefined) return "DEFAULT";
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function CellEditor({ initial, label, onDone }: {
  initial: Cell | undefined;
  label: string;
  onDone: (v: Cell | undefined, restoreFocus: boolean) => void;
}) {
  const init = initial === null || initial === undefined ? "" : String(initial);
  const [v, setV] = useState(init);
  const finished = useRef(false);
  const finish = (value: Cell | undefined, restoreFocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(value === init ? undefined : value, restoreFocus);
  };
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      className="cell-input"
      aria-label={label}
      value={v}
      rows={1}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v, false)}
      onKeyDown={(e) => {
        // Enter saves, Shift/Alt+Enter inserts a newline, Escape cancels.
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          finish(v, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(undefined, true);
        }
        e.stopPropagation();
      }}
    />
  );
}

export function DataGrid({ result, fallbackColumns, orderBy, orderDesc, onSort, rowOffset = 0, editing, onSelect, resetKey, emptyState }: Props) {
  const [sel, setSelState] = useState<Selection | null>(null);
  const [editCell, setEditCell] = useState<Selection | null>(null);
  const gridBody = useRef<HTMLTableSectionElement>(null);
  const selectedCell = useRef<HTMLTableCellElement>(null);
  const restoreFocus = useRef(false);
  const revealCell = useRef(false);
  const columns = result.columns.length ? result.columns : (fallbackColumns ?? []);

  const setSel = (s: Selection | null) => {
    setSelState(s);
    onSelect?.(s);
  };

  // Selection refers to row indices; reset when the rows change underneath.
  useEffect(() => {
    const first = gridBody.current === document.activeElement && result.rows.length && columns.length
      ? { r: 0, c: 0 }
      : null;
    setSelState(first);
    setEditCell(null);
    onSelect?.(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey ?? result]);

  useEffect(() => {
    if (restoreFocus.current && !editCell) {
      restoreFocus.current = false;
      gridBody.current?.focus({ preventScroll: true });
    }
    if (revealCell.current) {
      revealCell.current = false;
      selectedCell.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [editCell, sel]);

  const valueAt = (r: number, c: number): Cell | undefined => {
    const p = editing?.pending(r, c);
    if (p !== undefined) return p;
    return result.rows[r]?.[c];
  };
  const selected = sel ? valueAt(sel.r, sel.c) : undefined;
  const hasSel = sel !== null && sel.r < result.rows.length;

  if (!columns.length) {
    return (
      <div className="grid-wrap">
        <div className="grid-scroll">
          {emptyState ?? <div className="grid-empty">
            {result.rowsAffected != null ? tf("OK, {count} row(s) affected", { count: result.rowsAffected }) : t("No columns")}
            <span className="muted"> · {result.elapsedMs} ms</span>
          </div>}
        </div>
      </div>
    );
  }

  const startEdit = (r: number, c: number) => {
    if (!editing || !editing.canEdit(c) || editing.rowState(r) === "deleted") return;
    setSel({ r, c });
    setEditCell({ r, c });
  };

  return (
    <div className="grid-wrap">
      <div
        className="grid-scroll"
        role="region"
        aria-label={t("Data grid")}
      >
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {columns.map((c) => (
                <th key={c} className={onSort ? "sortable" : ""}
                  aria-sort={orderBy === c ? (orderDesc ? "descending" : "ascending") : undefined}>
                  {onSort ? <button type="button" className="link grid-sort" onClick={() => onSort(c)}>
                    <span>{c}</span>
                    {orderBy === c && <span className="sort" aria-hidden="true">{orderDesc ? "▼" : "▲"}</span>}
                  </button> : c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            ref={gridBody}
            tabIndex={result.rows.length ? 0 : undefined}
            onFocus={(e) => {
              if (e.target === e.currentTarget && !sel && result.rows.length && e.currentTarget.matches(":focus-visible")) {
                revealCell.current = true;
                setSel({ r: 0, c: 0 });
              }
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || editCell || !result.rows.length) return;
              const move = (dr: number, dc: number) => {
                e.preventDefault();
                revealCell.current = true;
                const r = Math.max(0, Math.min(result.rows.length - 1, (sel?.r ?? 0) + dr));
                const c = Math.max(0, Math.min(columns.length - 1, (sel?.c ?? 0) + dc));
                setSel({ r, c });
              };
              if (e.key === "ArrowDown") move(1, 0);
              else if (e.key === "ArrowUp") move(-1, 0);
              else if (e.key === "ArrowLeft") move(0, -1);
              else if (e.key === "ArrowRight") move(0, 1);
              else if (e.key === "Enter" && hasSel && sel && editing?.canEdit(sel.c) && editing.rowState(sel.r) !== "deleted") {
                e.preventDefault();
                startEdit(sel.r, sel.c);
              } else if (hasSel && (e.metaKey || e.ctrlKey) && e.key === "c") {
                void navigator.clipboard.writeText(show(selected));
              }
            }}
          >
            {result.rows.map((row, r) => {
              const state = editing?.rowState(r);
              return (
                <tr key={r} className={`${sel?.r === r ? "sel-row" : ""} ${state ? `row-${state}` : ""}`}>
                  <td className="rownum">{state === "inserted" ? "+" : rowOffset + r + 1}</td>
                  {row.map((_, c) => {
                    const v = valueAt(r, c);
                    const dirty = editing?.pending(r, c) !== undefined;
                    const isEditing = editCell?.r === r && editCell.c === c;
                    const isSelected = sel?.r === r && sel.c === c;
                    return (
                      <td
                        key={c}
                        ref={isSelected ? selectedCell : undefined}
                        className={`${v == null ? "null" : typeof v === "number" ? "num" : ""} ${isSelected ? "sel" : ""} ${dirty ? "dirty" : ""} ${isEditing ? "editing" : ""}`}
                        onClick={() => {
                          if (isEditing) return;
                          gridBody.current?.focus({ preventScroll: true });
                          setSel({ r, c });
                        }}
                        onDoubleClick={() => startEdit(r, c)}
                        title={typeof v === "string" && v.length > 60 ? v.slice(0, 500) : undefined}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={v}
                            label={columns[c]}
                            onDone={(nv, focusGrid) => {
                              restoreFocus.current = focusGrid;
                              setEditCell(null);
                              if (nv !== undefined && editing) editing.onChange(r, c, nv);
                            }}
                          />
                        ) : (
                          show(v).slice(0, 200)
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!result.rows.length && (emptyState ?? <div className="grid-empty">{t("0 rows")}</div>)}
      </div>
      {hasSel && sel && (
        <div className="cell-detail">
          <div className="cell-detail-head">
            <b>{columns[sel.c]}</b>
            <button className="link" onClick={() => navigator.clipboard.writeText(show(selected))}>
              <Copy size={14} />{t("Copy")} </button>
            <button className="link" aria-label={t("Close cell details")} onClick={() => {
              gridBody.current?.focus({ preventScroll: true });
              setSel(null);
            }}>
              ✕
            </button>
          </div>
          <pre>{show(selected)}</pre>
        </div>
      )}
    </div>
  );
}
