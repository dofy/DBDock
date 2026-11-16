import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errText, type Cell, type Change, type Kind, type QueryResult, type TableData } from "../api";
import { DataGrid, type GridEditing, type Selection } from "./DataGrid";
import { SqlInput } from "./SqlInput";
import { Check, CircleSlash, Copy, Eye, Minus, Plus, RefreshCw, Undo2, X } from "lucide-react";

interface Props {
  sessionId: string;
  kind: Kind;
  schema: string;
  table: string;
  isView: boolean;
  dark: boolean;
}

const PAGE_SIZES = [100, 300, 1000];
const BINARY = /blob|binary|bytea|bit\b|geometry|point|polygon/i;

export function TableView({ sessionId, kind, schema, table, isView, dark }: Props) {
  const [mode, setMode] = useState<"data" | "structure">("data");
  const [data, setData] = useState<TableData | null>(null);
  const [structure, setStructure] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(300);
  const [page, setPage] = useState(0);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDesc, setOrderDesc] = useState(false);
  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState("");

  // Pending edits: row index -> column index -> new value.
  const [edits, setEdits] = useState<Record<number, Record<number, Cell>>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserted, setInserted] = useState<(Cell | undefined)[][]>([]);
  const [sel, setSel] = useState<Selection | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const clearPending = () => {
    setEdits({});
    setDeleted(new Set());
    setInserted([]);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, s] = await Promise.all([
        api.tableData({ sessionId, schema, table, limit, offset: page * limit, orderBy, orderDesc, filter: filter || undefined }),
        structure ? Promise.resolve(structure) : api.structure(sessionId, schema, table),
      ]);
      setData(d);
      setStructure(s);
      clearPending();
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
    // structure is cached once loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, schema, table, limit, page, orderBy, orderDesc, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const colNames = useMemo(() => structure?.rows.map((r) => String(r[0])) ?? [], [structure]);
  const columns = data?.result.columns.length ? data.result.columns : colNames;
  const { pk, colTypes } = useMemo(() => {
    const keyIdx = structure?.columns.indexOf("key") ?? -1;
    const typeIdx = structure?.columns.indexOf("type") ?? -1;
    const pk = structure && keyIdx >= 0 ? structure.rows.filter((r) => r[keyIdx] === "PRI").map((r) => String(r[0])) : [];
    const colTypes = new Map(structure?.rows.map((r) => [String(r[0]), typeIdx >= 0 ? String(r[typeIdx] ?? "") : ""]) ?? []);
    return { pk, colTypes };
  }, [structure]);

  const editable = !isView && pk.length > 0 && pk.every((k) => columns.includes(k));
  const baseRows = data?.result.rows.length ?? 0;
  const pendingCount = Object.keys(edits).filter((r) => !deleted.has(Number(r))).length + deleted.size + inserted.length;

  const display = useMemo<QueryResult | null>(() => {
    if (!data) return null;
    if (!inserted.length) return data.result;
    return { ...data.result, columns, rows: [...data.result.rows, ...inserted.map(() => columns.map(() => undefined as unknown as Cell))] };
  }, [data, inserted, columns]);

  const editing: GridEditing | undefined = editable
    ? {
        canEdit: (c) => !BINARY.test(colTypes.get(columns[c]) ?? ""),
        // Untouched cells of inserted rows stay undefined and render as DEFAULT.
        pending: (r, c) => (r >= baseRows ? inserted[r - baseRows]?.[c] : edits[r]?.[c]),
        rowState: (r) => (r >= baseRows ? "inserted" : deleted.has(r) ? "deleted" : undefined),
        onChange: (r, c, v) => {
          if (r >= baseRows) {
            setInserted((rows) => rows.map((row, i) => (i === r - baseRows ? row.map((x, j) => (j === c ? v : x)) : row)));
          } else {
            setEdits((e) => ({ ...e, [r]: { ...e[r], [c]: v } }));
          }
        },
      }
    : undefined;

  const buildChanges = (): Change[] => {
    if (!data) return [];
    const rows = data.result.rows;
    const keyOf = (row: Cell[]) => Object.fromEntries(pk.map((k) => [k, row[columns.indexOf(k)]]));
    const out: Change[] = [];
    for (const [r, cols] of Object.entries(edits)) {
      const ri = Number(r);
      if (deleted.has(ri)) continue;
      out.push({ op: "update", key: keyOf(rows[ri]), set: Object.fromEntries(Object.entries(cols).map(([c, v]) => [columns[Number(c)], v])) });
    }
    for (const r of deleted) out.push({ op: "delete", key: keyOf(rows[r]) });
    for (const row of inserted) {
      const values: Record<string, Cell> = {};
      row.forEach((v, c) => {
        if (v !== undefined) values[columns[c]] = v;
      });
      out.push({ op: "insert", values });
    }
    return out;
  };

  const showPreview = async () => {
    try {
      setPreview(await api.previewChanges(sessionId, schema, table, buildChanges()));
    } catch (e) {
      setError(errText(e));
    }
  };

  const commit = async () => {
    if (!pendingCount || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.applyChanges(sessionId, schema, table, buildChanges());
      setPreview(null);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the visible tab reacts.
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && root.current?.offsetParent) {
        e.preventDefault();
        void commitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const guard = async (fn: () => void) => {
    if (pendingCount && !(await ask(`Discard ${pendingCount} uncommitted change(s)?`, { title: "Discard changes", kind: "warning" }))) return;
    fn();
  };

  const sort = (col: string) =>
    void guard(() => {
      if (orderBy !== col) {
        setOrderBy(col);
        setOrderDesc(false);
      } else if (!orderDesc) setOrderDesc(true);
      else setOrderBy(undefined);
      setPage(0);
    });

  const toggleDelete = () => {
    if (!sel) return;
    if (sel.r >= baseRows) {
      setInserted((rows) => rows.filter((_, i) => i !== sel.r - baseRows));
      return;
    }
    setDeleted((d) => {
      const n = new Set(d);
      if (n.has(sel.r)) n.delete(sel.r);
      else n.add(sel.r);
      return n;
    });
  };

  const setNull = () => {
    if (sel && editing?.canEdit(sel.c) && editing.rowState(sel.r) !== "deleted") editing.onChange(sel.r, sel.c, null);
  };

  return (
    <div className="tableview" ref={root}>
      <div className="toolbar">
        <div className="seg">
          <button className={mode === "data" ? "on" : ""} onClick={() => setMode("data")}>
            Data
          </button>
          <button className={mode === "structure" ? "on" : ""} onClick={() => setMode("structure")}>
            Structure
          </button>
        </div>
        {mode === "data" && (
          <div className="filter">
            <span className="muted">WHERE</span>
            <SqlInput
              kind={kind}
              table={table}
              columns={colNames}
              value={filterDraft}
              onChange={setFilterDraft}
              onSubmit={() =>
                void guard(() => {
                  setPage(0);
                  setFilter(filterDraft.trim());
                })
              }
              placeholder="id > 10 AND name LIKE 'a%'   (Enter to apply)"
              dark={dark}
            />
          </div>
        )}
        <span className="spacer" />
        {mode === "data" && editable && (
          <>
            <button onClick={() => setInserted((rows) => [...rows, columns.map(() => undefined)])} title="Add a row">
              <Plus size={14} />Row
            </button>
            <button onClick={toggleDelete} disabled={!sel} title="Delete or restore the selected row">
              <Minus size={14} />Row
            </button>
            <button onClick={setNull} disabled={!sel} title="Set the selected cell to NULL">
              <CircleSlash size={14} />NULL
            </button>
          </>
        )}
        {mode === "data" && !editable && data && (
          <span className="muted small" title="Editing needs a primary key">
            {isView ? "view · read-only" : "no primary key · read-only"}
          </span>
        )}
        <button onClick={() => void guard(() => void load())} disabled={loading} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {pendingCount > 0 && (
        <div className="pending-bar">
          <span>
            {pendingCount} pending change{pendingCount > 1 ? "s" : ""}
          </span>
          <span className="spacer" />
          <button onClick={showPreview}><Eye size={14} />Preview SQL</button>
          <button onClick={clearPending}><Undo2 size={14} />Discard</button>
          <button className="primary" onClick={() => void commit()} disabled={busy}>
            <Check size={14} />
            {busy ? "Committing…" : "Commit ⌘S"}
          </button>
        </div>
      )}

      {error && <pre className="error">{error}</pre>}

      {mode === "data" && display && (
        <>
          <DataGrid
            result={display}
            fallbackColumns={colNames}
            orderBy={orderBy}
            orderDesc={orderDesc}
            onSort={sort}
            rowOffset={page * limit}
            editing={editing}
            resetKey={data}
            onSelect={setSel}
          />
          <div className="statusbar">
            <button disabled={page === 0 || loading} onClick={() => void guard(() => setPage((p) => p - 1))}>
              ‹
            </button>
            <span>
              rows {baseRows ? page * limit + 1 : 0}–{page * limit + baseRows}
            </span>
            <button disabled={!data?.hasMore || loading} onClick={() => void guard(() => setPage((p) => p + 1))}>
              ›
            </button>
            <select
              value={limit}
              onChange={(e) => {
                const n = Number(e.target.value);
                void guard(() => {
                  setLimit(n);
                  setPage(0);
                });
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </select>
            {editable && <span className="muted">double-click to edit · Enter saves · Esc cancels</span>}
            <span className="spacer" />
            <code className="muted sql-line">{data?.sql}</code>
            <span className="muted">{data?.result.elapsedMs} ms</span>
          </div>
        </>
      )}

      {mode === "structure" && structure && <DataGrid result={structure} />}

      {preview && (
        <div className="modal-backdrop" onMouseDown={() => setPreview(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Pending SQL</h2>
            <pre className="sql-preview">{preview.map((s) => `${s};`).join("\n")}</pre>
            <p className="muted small">Runs in one transaction. Each UPDATE / DELETE must match exactly one row, or everything is rolled back.</p>
            <div className="actions">
              <button onClick={() => navigator.clipboard.writeText(preview.map((s) => `${s};`).join("\n"))}><Copy size={14} />Copy</button>
              <span className="spacer" />
              <button onClick={() => setPreview(null)}><X size={14} />Close</button>
              <button className="primary" onClick={() => void commit()} disabled={busy}>
                <Check size={14} />Commit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
