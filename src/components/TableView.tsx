import { t, tf } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, cancellableBrowserRequest, errText, type Cell, type Change, type Kind, type MetadataKind, type QueryResult, type SqlProtection, type TableData, type TableFilter } from "../api";
import { DataGrid, type GridEditing, type Selection } from "./DataGrid";
import { SqlInput } from "./SqlInput";
import { VisualFilter } from "./VisualFilter";
import { Check, CircleSlash, Copy, Eye, Filter, Info, Minus, Plus, RefreshCw, Undo2, X } from "lucide-react";

interface Props {
  sessionId: string;
  kind: Kind;
  schema: string;
  table: string;
  isView: boolean;
  protection: SqlProtection;
  connectionName: string;
  dark: boolean;
  onDirtyChange: (dirty: boolean, busy: boolean) => void;
}

const PAGE_SIZES = [5, 25, 100, 300, 1000];
const BINARY = /blob|binary|bytea|bit\b|geometry|point|polygon/i;

export function TableView({ sessionId, kind, schema, table, isView, protection, connectionName, dark, onDirtyChange }: Props) {
  const [mode, setMode] = useState<"data" | "structure" | MetadataKind>("data");
  const [data, setData] = useState<TableData | null>(null);
  const [structure, setStructure] = useState<QueryResult | null>(null);
  const [structureLoading, setStructureLoading] = useState(true);
  const [structureReload, setStructureReload] = useState(0);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(5);
  const [page, setPage] = useState(0);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDesc, setOrderDesc] = useState(false);
  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [visualFilter, setVisualFilter] = useState<TableFilter>();
  const [showFilters, setShowFilters] = useState(false);
  const [metadata, setMetadata] = useState<{ kind: MetadataKind; result?: QueryResult; error?: string }>();
  const [metadataReload, setMetadataReload] = useState(0);
  const [conflict, setConflict] = useState(false);

  // Pending edits: row index -> column index -> new value.
  const [edits, setEdits] = useState<Record<number, Record<number, Cell>>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserted, setInserted] = useState<(Cell | undefined)[][]>([]);
  const [sel, setSel] = useState<Selection | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const currentRead = useRef<{ cancel: () => void } | null>(null);

  const clearPending = () => {
    setEdits({});
    setDeleted(new Set());
    setInserted([]);
  };

  const load = useCallback(async () => {
    const current = ++request.current;
    currentRead.current?.cancel();
    const read = cancellableBrowserRequest((requestId) => api.tableData({ sessionId, requestId, schema, table, limit, offset: page * limit, orderBy, orderDesc, filter: filter || undefined, visualFilter, captureVersions: !isView && protection !== "browseOnly" }));
    currentRead.current = read;
    setLoading(true);
    setError(null);
    setConflict(false);
    try {
      const d = await read.promise;
      if (current !== request.current) return;
      setData(d);
      clearPending();
    } catch (e) {
      if (current === request.current) setError(errText(e));
    } finally {
      if (current === request.current) { currentRead.current = null; setLoading(false); }
    }
  }, [sessionId, schema, table, limit, page, orderBy, orderDesc, filter, visualFilter, isView, protection]);

  useEffect(() => {
    void load();
    return () => { request.current++; currentRead.current?.cancel(); currentRead.current = null; };
  }, [load]);

  useEffect(() => {
    let current = true;
    setStructure(null);
    setStructureError(null);
    setStructureLoading(true);
    const read = cancellableBrowserRequest((requestId) => api.structure(sessionId, schema, table, requestId));
    read.promise.then((result) => {
      if (current) setStructure(result);
    }).catch((e) => {
      if (current) setStructureError(errText(e));
    }).finally(() => {
      if (current) setStructureLoading(false);
    });
    return () => { current = false; read.cancel(); };
  }, [sessionId, schema, table, structureReload]);

  useEffect(() => {
    if (mode !== "indexes" && mode !== "foreignKeys") return;
    let current = true;
    setMetadata(undefined);
    const read = cancellableBrowserRequest((requestId) => api.tableMetadata(sessionId, schema, table, mode, requestId));
    read.promise.then((result) => {
      if (current) setMetadata({ kind: mode, result });
    }).catch((e) => {
      if (current) setMetadata({ kind: mode, error: errText(e) });
    });
    return () => { current = false; read.cancel(); };
  }, [mode, sessionId, schema, table, metadataReload]);

  const colNames = useMemo(() => structure?.rows.map((r) => String(r[0])) ?? [], [structure]);
  const columns = data?.result.columns.length ? data.result.columns : colNames;
  const { pk, colTypes } = useMemo(() => {
    const keyIdx = structure?.columns.indexOf("key") ?? -1;
    const typeIdx = structure?.columns.indexOf("type") ?? -1;
    const pk = structure && keyIdx >= 0 ? structure.rows.filter((r) => r[keyIdx] === "PRI").map((r) => String(r[0])) : [];
    const colTypes = new Map(structure?.rows.map((r) => [String(r[0]), typeIdx >= 0 ? String(r[typeIdx] ?? "") : ""]) ?? []);
    return { pk, colTypes };
  }, [structure]);

  const baseRows = data?.result.rows.length ?? 0;
  const editable = protection !== "browseOnly" && !isView && pk.length > 0 && pk.every((k) => columns.includes(k)) && data?.rowVersions.length === baseRows;
  const pendingCount = Object.keys(edits).filter((r) => !deleted.has(Number(r))).length + deleted.size + inserted.length;
  useEffect(() => {
    onDirtyChange(pendingCount > 0, busy);
    return () => onDirtyChange(false, false);
  }, [pendingCount, busy, onDirtyChange]);

  const display = useMemo<QueryResult | null>(() => {
    if (!data) return null;
    if (!inserted.length) return data.result;
    return { ...data.result, columns, rows: [...data.result.rows, ...inserted.map(() => columns.map(() => undefined as unknown as Cell))] };
  }, [data, inserted, columns]);

  const editing: GridEditing | undefined = editable && !loading && !busy
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
      out.push({ op: "update", key: keyOf(rows[ri]), version: data.rowVersions[ri], set: Object.fromEntries(Object.entries(cols).map(([c, v]) => [columns[Number(c)], v])) });
    }
    for (const r of deleted) out.push({ op: "delete", key: keyOf(rows[r]), version: data.rowVersions[r] });
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
    if (!pendingCount || busy || loading) return;
    const changes = buildChanges();
    setBusy(true);
    try {
      const confirmed = protection === "confirm";
      if (confirmed && !(await ask(tf("Commit {count} change(s) to {name} / {table}?", {
        count: changes.length, name: connectionName, table: `${schema}.${table}`,
      }), { title: t("Confirm table changes"), kind: "warning", okLabel: t("Commit"), cancelLabel: t("Cancel") }))) return;
      setError(null);
      setConflict(false);
      await api.applyChanges(sessionId, schema, table, changes, confirmed);
      clearPending();
      setPreview(null);
      await load();
    } catch (e) {
      setConflict(String(e).startsWith("Row conflict:"));
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
    if (busy || loading) return;
    if (pendingCount && !(await ask(tf("Discard {count} uncommitted change(s)?", { count: pendingCount }), { title: t("Discard changes"), kind: "warning", okLabel: t("Discard"), cancelLabel: t("Cancel") }))) return;
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
    if (!sel || !editable || busy || loading) return;
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

  const activeMetadata = metadata?.kind === mode ? metadata : undefined;
  const showingMetadata = mode === "indexes" || mode === "foreignKeys";
  const refresh = () => {
    if (showingMetadata) {
      setMetadata(undefined);
      setMetadataReload((n) => n + 1);
    } else if (mode === "structure") {
      setStructureReload((n) => n + 1);
    } else {
      void guard(() => {
        if (!structure) setStructureReload((n) => n + 1);
        void load();
      });
    }
  };

  return (
    <div className="tableview" ref={root}>
      <div className="toolbar">
        <div className="seg">
          <button className={mode === "data" ? "on" : ""} onClick={() => setMode("data")}>
             {t("Data")} </button>
          <button className={mode === "structure" ? "on" : ""} onClick={() => setMode("structure")}>
             {t("Structure")} </button>
          <button className={mode === "indexes" ? "on" : ""} onClick={() => setMode("indexes")}>{t("Indexes")}</button>
          <button className={mode === "foreignKeys" ? "on" : ""} onClick={() => setMode("foreignKeys")}>{t("Foreign keys")}</button>
        </div>
        {mode === "data" && <button disabled={!colNames.length} aria-expanded={showFilters} className={visualFilter || showFilters ? "on-btn" : ""} onClick={() => setShowFilters((v) => !v)}>
          <Filter size={14} />{t("Filters")}{visualFilter ? ` (${visualFilter.conditions.length})` : ""}
        </button>}
        {mode === "data" && protection === "automatic" && !showFilters && (
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
                  setVisualFilter(undefined);
                })
              }
              placeholder={t("id > 10 AND name LIKE 'a%'   (Enter to apply)")}
              dark={dark}
            />
          </div>
        )}
        <span className="spacer" />
        {mode === "data" && editable && (
          <>
            <button disabled={loading || busy} onClick={() => setInserted((rows) => [...rows, columns.map(() => undefined)])} title={t("Add a row")}>
              <Plus size={14} />{t("Row")} </button>
            <button onClick={toggleDelete} disabled={!sel || loading || busy} title={t("Delete or restore the selected row")}>
              <Minus size={14} />{t("Row")} </button>
            <button onClick={setNull} disabled={!sel || loading || busy} title={t("Set the selected cell to NULL")}>
              <CircleSlash size={14} />NULL
            </button>
          </>
        )}
        {mode === "data" && !editable && data && structure && (
          <span className="muted small" title={t("Editing needs a primary key")}>
            {protection === "browseOnly" ? t("Browse only") : isView ? t("view · read-only") : t("no primary key · read-only")}
          </span>
        )}
        {!data && mode === "data" && <select value={limit} aria-label={t("Rows per page")} onChange={(e) => { setPage(0); setLimit(Number(e.target.value)); }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} {t("/ page")}</option>)}
        </select>}
        <button onClick={refresh} disabled={busy || (mode === "data" && loading)} title={t("Refresh")}>
          <RefreshCw size={14} />
        </button>
      </div>

      {mode === "data" && showFilters && <VisualFilter columns={colNames} applied={visualFilter} onClose={() => setShowFilters(false)} onApply={(next) => {
        void guard(() => {
          setPage(0);
          setFilter("");
          setFilterDraft("");
          setVisualFilter(next);
          setShowFilters(false);
        });
      }} />}

      {pendingCount > 0 && (
        <div className="pending-bar">
          <span>
            {pendingCount}  {t("pending change")}{pendingCount > 1 && t("pending change") === "pending change" ? "s" : ""}
          </span>
          <span className="spacer" />
          <button onClick={showPreview} disabled={busy}><Eye size={14} />{t("Preview SQL")}</button>
          <button onClick={clearPending} disabled={busy || loading}><Undo2 size={14} />{t("Discard")}</button>
          <button className="primary" onClick={() => void commit()} disabled={busy}>
            <Check size={14} />
            {busy ? t("Committing…") : t("Commit ⌘S")}
          </button>
        </div>
      )}

      {error && mode === "data" && <pre className="error">{error}</pre>}
      {conflict && mode === "data" && <div className="toolbar">
        <button onClick={refresh}><RefreshCw size={14} />{t("Discard and reload rows")}</button>
      </div>}
      {structureError && !showingMetadata && <pre className="error">{t("Unable to load table structure; editing is unavailable.")} {structureError}</pre>}

      {((mode === "data" && loading && !display) || (mode === "structure" && structureLoading && !structure)) && <>
        <div className="loading-grid" aria-hidden="true">
          <div className="loading-grid-header" />
          {Array.from({ length: 40 }, (_, i) => <div className="loading-grid-row" key={i} />)}
        </div>
        <div className="statusbar loading-status" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          {t(mode === "data" ? "Loading rows…" : "Loading structure…")}
        </div>
      </>}

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
               {t("rows")} {baseRows ? page * limit + 1 : 0}–{page * limit + baseRows}
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
                  {n}  {t("/ page")} </option>
              ))}
            </select>
            {(kind === "postgres" || kind === "mysql") && <span className="muted" title={t("Table browsing uses a separate connection and shows committed data.")} aria-label={t("Table browsing uses a separate connection and shows committed data.")}><Info size={14} /></span>}
            {editable && <span className="muted">{t("double-click to edit · Enter saves · Esc cancels")}</span>}
            <span className="spacer" />
            <code className="muted sql-line">{data?.sql}</code>
            {loading ? <span className="loading-status" role="status"><span className="loading-spinner" aria-hidden="true" />{t("Loading rows…")}</span> : <span className="muted">{data?.result.elapsedMs} ms</span>}
          </div>
        </>
      )}

      {mode === "structure" && structure && <DataGrid result={structure} />}
      {showingMetadata && (activeMetadata?.result
        ? <DataGrid result={activeMetadata.result} />
        : activeMetadata?.error
          ? <pre className="error">{activeMetadata.error}</pre>
          : <div className="statusbar loading-status" role="status"><span className="loading-spinner" aria-hidden="true" />{t("Loading structure…")}</div>)}

      {preview && (
        <div className="modal-backdrop" onMouseDown={() => setPreview(null)}>
          <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t("Pending SQL")}</h2>
            <pre className="sql-preview">{preview.map((s) => `${s};`).join("\n")}</pre>
            <p className="muted small">{t("Runs in one transaction. Each UPDATE / DELETE must match exactly one row, or everything is rolled back.")}</p>
            <div className="actions">
              <button onClick={() => navigator.clipboard.writeText(preview.map((s) => `${s};`).join("\n"))}><Copy size={14} />{t("Copy")}</button>
              <span className="spacer" />
              <button onClick={() => setPreview(null)}><X size={14} />{t("Close")}</button>
              <button className="primary" onClick={() => void commit()} disabled={busy}>
                <Check size={14} />{t("Commit")} </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
