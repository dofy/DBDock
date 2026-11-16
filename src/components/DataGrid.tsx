import { useEffect, useRef, useState } from "react";
import type { Cell, QueryResult } from "../api";
import { Copy } from "lucide-react";

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
}

function show(v: Cell | undefined): string {
  if (v === undefined) return "DEFAULT";
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function CellEditor({ initial, onDone }: { initial: Cell | undefined; onDone: (v: Cell | undefined) => void }) {
  const init = initial === null || initial === undefined ? "" : String(initial);
  const [v, setV] = useState(init);
  // undefined = no change (unchanged text, or Escape).
  const finish = (val: string) => onDone(val === init ? undefined : val);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      className="cell-input"
      value={v}
      rows={1}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        // Enter saves, Shift/Alt+Enter inserts a newline, Escape cancels.
        if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          finish(v);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone(undefined);
        }
        e.stopPropagation();
      }}
    />
  );
}

export function DataGrid({ result, fallbackColumns, orderBy, orderDesc, onSort, rowOffset = 0, editing, onSelect, resetKey }: Props) {
  const [sel, setSelState] = useState<Selection | null>(null);
  const [editCell, setEditCell] = useState<Selection | null>(null);
  const columns = result.columns.length ? result.columns : (fallbackColumns ?? []);

  const setSel = (s: Selection | null) => {
    setSelState(s);
    onSelect?.(s);
  };

  // Selection refers to row indices; reset when the rows change underneath.
  useEffect(() => {
    setSelState(null);
    setEditCell(null);
    onSelect?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey ?? result]);

  const valueAt = (r: number, c: number): Cell | undefined => {
    const p = editing?.pending(r, c);
    if (p !== undefined) return p;
    return result.rows[r]?.[c];
  };
  const selected = sel ? valueAt(sel.r, sel.c) : undefined;
  const hasSel = sel !== null && sel.r < result.rows.length;

  if (!columns.length) {
    return (
      <div className="grid-empty">
        {result.rowsAffected != null ? `OK, ${result.rowsAffected} row(s) affected` : "No columns"}
        <span className="muted"> · {result.elapsedMs} ms</span>
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
        tabIndex={0}
        onKeyDown={(e) => {
          if (!sel || editCell) return;
          const move = (dr: number, dc: number) => {
            e.preventDefault();
            setSel({ r: Math.max(0, Math.min(result.rows.length - 1, sel.r + dr)), c: Math.max(0, Math.min(columns.length - 1, sel.c + dc)) });
          };
          if (e.key === "ArrowDown") move(1, 0);
          else if (e.key === "ArrowUp") move(-1, 0);
          else if (e.key === "ArrowLeft") move(0, -1);
          else if (e.key === "ArrowRight" || e.key === "Tab") move(0, 1);
          else if (e.key === "Enter") {
            e.preventDefault();
            startEdit(sel.r, sel.c);
          } else if ((e.metaKey || e.ctrlKey) && e.key === "c") {
            void navigator.clipboard.writeText(show(selected));
          }
        }}
      >
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {columns.map((c) => (
                <th key={c} onClick={onSort ? () => onSort(c) : undefined} className={onSort ? "sortable" : ""}>
                  {c}
                  {orderBy === c && <span className="sort">{orderDesc ? " ▼" : " ▲"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => {
              const state = editing?.rowState(r);
              return (
                <tr key={r} className={`${sel?.r === r ? "sel-row" : ""} ${state ? `row-${state}` : ""}`}>
                  <td className="rownum">{state === "inserted" ? "+" : rowOffset + r + 1}</td>
                  {row.map((_, c) => {
                    const v = valueAt(r, c);
                    const dirty = editing?.pending(r, c) !== undefined;
                    const isEditing = editCell?.r === r && editCell.c === c;
                    return (
                      <td
                        key={c}
                        className={`${v === null ? "null" : v === undefined ? "null" : typeof v === "number" ? "num" : ""} ${sel?.r === r && sel.c === c ? "sel" : ""} ${dirty ? "dirty" : ""} ${isEditing ? "editing" : ""}`}
                        onClick={() => setSel({ r, c })}
                        onDoubleClick={() => startEdit(r, c)}
                        title={typeof v === "string" && v.length > 60 ? v.slice(0, 500) : undefined}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={v}
                            onDone={(nv) => {
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
        {!result.rows.length && <div className="grid-empty">0 rows</div>}
      </div>
      {hasSel && sel && (
        <div className="cell-detail">
          <div className="cell-detail-head">
            <b>{columns[sel.c]}</b>
            <button className="link" onClick={() => navigator.clipboard.writeText(show(selected))}>
              <Copy size={14} />Copy
            </button>
            <button className="link" onClick={() => setSel(null)}>
              ✕
            </button>
          </div>
          <pre>{show(selected)}</pre>
        </div>
      )}
    </div>
  );
}
