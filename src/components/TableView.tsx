import { t, tf } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, cancellableBrowserRequest, errText, type Cell, type Change, type Kind, type MetadataKind, type QueryResult, type SqlProtection, type TableData, type TableFilter } from "../api";
import { DataGrid, ResultEmpty, type GridEditing, type Selection } from "./DataGrid";
import { SqlInput } from "./SqlInput";
import { describeVisualFilter, VisualFilter } from "./VisualFilter";
import { SchemaEditor } from "./SchemaEditor";
import { TableTransfer } from "./TableTransfer";
import { confirmSqlWrite } from "../sqlWriteConfirmation";
import { Check, CircleSlash, Copy, Eye, FileDown, FileUp, Filter, Info, Minus, Plus, RefreshCw, Settings2, Undo2, X } from "lucide-react";

interface Props {
  sessionId: string;
  kind: Kind;
  schema: string;
  table: string;
  isView: boolean;
  protection: SqlProtection;
  connectionName: string;
  env: string;
  dark: boolean;
  onSchemaChanged: () => void;
  onDirtyChange: (dirty: boolean, busy: boolean) => void;
}

const PAGE_SIZES = [5, 25, 100, 300, 1000];
const BINARY = /blob|binary|bytea|bit\b|geometry|point|polygon/i;

export function TableView({ sessionId, kind, schema, table, isView, protection, connectionName, env, dark, onSchemaChanged, onDirtyChange }: Props) {
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
  const [operation, setOperation] = useState<"schema" | "import" | "export">();
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
    if (!pendingCount || busy || loading || operation) return;
    const changes = buildChanges();
    setBusy(true);
    try {
      const confirmed = protection === "confirm";
      if (confirmed) {
        const counts = { insert: 0, update: 0, delete: 0 };
        for (const change of changes) counts[change.op]++;
        const sql = await api.previewChanges(sessionId, schema, table, changes.slice(0, 5));
        if (!(await confirmSqlWrite({
          connectionName, env, object: `${schema}.${table}`,
          title: t("Confirm table changes"), action: t("Commit"),
          summary: tf("{insert} inserted · {update} updated · {delete} deleted", counts),
          sql: sql.map((statement) => `${statement};`).join("\n") + (changes.length > sql.length ? "\n…" : ""),
        }))) return;
      }
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

  const allowTableWrites = protection !== "browseOnly" && !isView;
  const pendingTitle = pendingCount ? t("Commit or discard pending edits first") : undefined;
  const appliedFilter = visualFilter ? describeVisualFilter(visualFilter) : filter;
  const applyFilter = (where: string, visual?: TableFilter) => void guard(() => {
    setPage(0);
    setFilter(where);
    setFilterDraft(where);
    setVisualFilter(visual);
    setShowFilters(false);
  });
  const addRow = () => setInserted((rows) => [...rows, columns.map(() => undefined)]);
  const emptyState = !loading && !error && (appliedFilter
    ? <ResultEmpty illustrated title={t("No rows match these filters")} detail={t("Clear the filters to show all rows.")}
        action={<button type="button" disabled={busy} onClick={() => applyFilter("")}>{t("Clear filters")}</button>} />
    : <ResultEmpty illustrated title={t(page ? "No rows on this page" : "This table is empty")}
        action={!page && editable && <button type="button" disabled={busy} onClick={addRow}><Plus size={14} />{t("Add a row")}</button>} />);
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
      <div className="toolbar table-toolbar">
        <div className="seg" role="group" aria-label={t("Table view")}>
          <button className={mode === "data" ? "on" : ""} aria-pressed={mode === "data"} onClick={() => setMode("data")}>
             {t("Data")} </button>
          <button className={mode === "structure" ? "on" : ""} aria-pressed={mode === "structure"} onClick={() => setMode("structure")}>
             {t("Structure")} </button>
          <button className={mode === "indexes" ? "on" : ""} aria-pressed={mode === "indexes"} onClick={() => setMode("indexes")}>{t("Indexes")}</button>
          <button className={mode === "foreignKeys" ? "on" : ""} aria-pressed={mode === "foreignKeys"} onClick={() => setMode("foreignKeys")}>{t("Foreign keys")}</button>
        </div>
        <div className="workspace-tools table-tools">
          {mode === "data" && editable && <>
            <button disabled={loading || busy} onClick={addRow} title={t("Add a row")} aria-label={t("Add a row")}>
              <Plus size={14} /><span className="table-row-label">{t("Row")}</span></button>
            <button onClick={toggleDelete} disabled={!sel || loading || busy} title={t("Delete or restore the selected row")} aria-label={t("Delete or restore the selected row")}>
              <Minus size={14} /><span className="table-row-label">{t("Row")}</span></button>
            <button onClick={setNull} disabled={!sel || loading || busy} title={t("Set the selected cell to NULL")} aria-label={t("Set the selected cell to NULL")}>
              <CircleSlash size={14} /><span className="table-row-label">NULL</span>
            </button>
          </>}
          {mode === "structure" && allowTableWrites && <button disabled={busy || structureLoading || pendingCount > 0}
            title={pendingTitle} onClick={() => setOperation("schema")}><Settings2 size={14} />{t("Edit structure")}</button>}
          {mode === "data" && allowTableWrites && <button disabled={busy || !colNames.length || pendingCount > 0}
            title={pendingTitle ?? t("Import table data")} onClick={() => setOperation("import")} aria-label={t("Import table data")}><FileUp size={14} /></button>}
          {mode === "data" && <button disabled={busy} title={t("Export table data")} onClick={() => setOperation("export")} aria-label={t("Export table data")}><FileDown size={14} /></button>}
          <button onClick={refresh} disabled={busy || (mode === "data" && loading)} title={t("Refresh")} aria-label={t("Refresh")}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {mode === "data" && <>
        <div className="toolbar table-filter-bar">
          <button disabled={!colNames.length} aria-expanded={showFilters} className={appliedFilter || showFilters ? "on-btn" : ""} onClick={() => setShowFilters((v) => !v)}>
            <Filter size={14} />{t("Filters")}
          </button>
          {protection === "automatic" && !showFilters && <div className="filter">
            <span className="muted">WHERE</span>
            <SqlInput kind={kind} table={table} columns={colNames} value={filterDraft} onChange={setFilterDraft}
              onSubmit={() => applyFilter(filterDraft.trim())} placeholder={t("id > 10 AND name LIKE 'a%'   (Enter to apply)")} dark={dark} />
          </div>}
          {appliedFilter && <div className="applied-filter">
            <span className="muted">{t("Applied filter")}</span>
            <code title={appliedFilter}>{appliedFilter}</code>
            <button className="icon-btn" disabled={busy || loading} onClick={() => applyFilter("")} title={t("Clear filters")} aria-label={t("Clear filters")}><X size={14} /></button>
          </div>}
        </div>
        {showFilters && <VisualFilter columns={colNames} applied={visualFilter} onClose={() => setShowFilters(false)} onApply={(next) => applyFilter("", next)} />}
      </>}

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
        {mode === "structure" && <div className="statusbar loading-status" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          {t("Loading structure…")}
        </div>}
      </>}

      {mode === "data" && display && (
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
            emptyState={emptyState || undefined}
          />
      )}

      {mode === "data" && <div className="statusbar table-status">
          <div className="workspace-tools" role="group" aria-label={t("Pagination")}>
            <button disabled={page === 0 || loading || busy} title={t("Previous page")} aria-label={t("Previous page")} onClick={() => void guard(() => setPage((p) => p - 1))}>
              ‹
            </button>
            <span>{!display ? "—" : baseRows ? `${t("rows")} ${page * limit + 1}–${page * limit + baseRows}` : t("0 rows")}</span>
            <button disabled={!data?.hasMore || loading || busy} title={t("Next page")} aria-label={t("Next page")} onClick={() => void guard(() => setPage((p) => p + 1))}>
              ›
            </button>
            <select
              value={limit} aria-label={t("Rows per page")} disabled={busy || (loading && !!data)}
              onChange={(e) => {
                const n = Number(e.target.value);
                const changePageSize = () => {
                  setLimit(n);
                  setPage(0);
                };
                if (data) void guard(changePageSize);
                else changePageSize();
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}  {t("/ page")} </option>
              ))}
            </select>
          </div>
          {loading ? <span className="loading-status" role="status"><span className="loading-spinner" aria-hidden="true" />{t("Loading rows…")}</span> : data && <>
            {(kind === "postgres" || kind === "mysql") && <span className="muted table-info" title={t("Table browsing uses a separate connection and shows committed data.")} aria-label={t("Table browsing uses a separate connection and shows committed data.")}><Info size={14} /></span>}
            {!editable && structure && protection !== "browseOnly" && <span className="muted">{t(isView ? "view · read-only" : "no primary key · read-only")}</span>}
            {editable && <span className="muted table-edit-hint">{t("double-click to edit · Enter saves · Esc cancels")}</span>}
            <code className="muted sql-line" title={data.sql}>{data.sql}</code>
            <span className="muted table-elapsed">{data.result.elapsedMs} ms</span>
          </>}
      </div>}

      {mode === "structure" && structure && <DataGrid result={structure} />}
      {showingMetadata && (activeMetadata?.result
        ? <DataGrid result={activeMetadata.result} />
        : activeMetadata?.error
          ? <pre className="error">{activeMetadata.error}</pre>
          : <div className="statusbar loading-status" role="status"><span className="loading-spinner" aria-hidden="true" />{t("Loading structure…")}</div>)}

      {operation === "schema" && <SchemaEditor sessionId={sessionId} schema={schema} table={table} columns={colNames}
        connectionName={connectionName} env={env} kind={kind} protection={protection} onBusy={setBusy}
        onClose={() => setOperation(undefined)}
        onApplied={() => {
          setOperation(undefined);
          setStructureReload((n) => n + 1);
          setMetadataReload((n) => n + 1);
          const changedQuery = page !== 0 || !!orderBy || !!filter || !!visualFilter;
          setPage(0);
          setOrderBy(undefined);
          setOrderDesc(false);
          setFilter("");
          setFilterDraft("");
          setVisualFilter(undefined);
          setData(null);
          if (!changedQuery) void load();
          onSchemaChanged();
        }}
      />}
      {(operation === "import" || operation === "export") && <TableTransfer sessionId={sessionId} schema={schema} table={table}
        connectionName={connectionName} env={env} columns={colNames} mode={operation} onBusy={setBusy} onClose={() => setOperation(undefined)}
        onImported={() => { setOperation(undefined); void load(); }} />}

      {preview && (
        <div className="modal-backdrop" onMouseDown={() => setPreview(null)}>
          <div className="modal wide" role="dialog" aria-modal="true" aria-label={t("Pending SQL")} onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t("Pending SQL")}</h2>
            <p className="sql-dialog-target" data-production={env === "production"}>{env === "production" && <span>{t("PROD")} · </span>}
              {connectionName} / {schema}.{table}
            </p>
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
