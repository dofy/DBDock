import { useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileDown, FileUp, X } from "lucide-react";
import { api, cancellableBrowserRequest, errText } from "../api";
import { t, tf } from "../i18n";
import type { ExportFormat } from "../sqlResultExport";
import { parseTableFile, type TableFile } from "../tableImport";
import type { TableActionTarget } from "./SchemaEditor";
import { useToast } from "./Toast";
import { confirmSqlWrite } from "../sqlWriteConfirmation";

interface Props extends TableActionTarget {
  table: string;
  columns: string[];
  mode: "import" | "export";
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onImported: () => void;
}

export function TableTransfer({ sessionId, schema, table, connectionName, env, columns, mode, onClose, onBusy, onImported }: Props) {
  const importing = mode === "import";
  const action = t(importing ? "Import table data" : "Export table data");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [loaded, setLoaded] = useState<{ name: string; data: TableFile }>();
  const [mapping, setMapping] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [canStop, setCanStop] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  const toast = useToast();
  const mapped = mapping.filter(Boolean);
  const valid = mapped.length > 0 && new Set(mapped).size === mapped.length;
  const target = `${schema}.${table}`;

  const chooseFile = async () => {
    setBusy(true);
    setError("");
    try {
      const path = await open({ multiple: false, filters: [{ name: "CSV / JSON", extensions: ["csv", "json"] }] });
      if (typeof path !== "string") return;
      const data = parseTableFile(await api.readTableFile(path), path.toLowerCase().endsWith(".json") ? "json" : "csv");
      setLoaded({ name: path.split("/").pop() ?? path, data });
      setMapping(data.columns.map((column) => columns.includes(column) ? column : ""));
    } catch (e) {
      setLoaded(undefined);
      setMapping([]);
      setError(errText(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  };

  const applyImport = async () => {
    if (!loaded || !valid || busy) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (!(await confirmSqlWrite({
        connectionName, env, object: target,
        title: t("Confirm import"), action: t("Import"),
        summary: tf("Append {count} row(s) from {file} into {columns} column(s).", { count: loaded.data.rows.length, file: loaded.name, columns: mapped.length }),
      }))) return;
      const indexes = mapping.flatMap((column, index) => column ? [index] : []);
      const count = await api.importRows(sessionId, schema, table, mapped, loaded.data.rows.map((row) => indexes.map((i) => row[i])), true);
      toast("ok", tf("Imported {count} row(s)", { count }));
      onImported();
    } catch (e) { setError(errText(e)); }
    finally { onBusy(false); setBusy(false); }
  };

  const applyExport = async () => {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setError("");
    let stopped = false;
    try {
      const fileName = table.replace(/[/:\\\x00-\x1F]/g, "_");
      const path = await save({ defaultPath: `${fileName}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (!path) return;
      const read = cancellableBrowserRequest((requestId) => api.exportTable(sessionId, schema, table, path, format, requestId));
      cancel.current = () => { stopped = true; setCanStop(false); read.cancel(); };
      setCanStop(true);
      const count = await read.promise;
      toast("ok", tf("Exported {count} row(s)", { count }));
      onClose();
    } catch (e) {
      if (!stopped) setError(errText(e));
    } finally {
      cancel.current = null;
      setCanStop(false);
      onBusy(false);
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
    <div className="modal wide table-tool" role="dialog" aria-modal="true" aria-label={action} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h2>{action}</h2>
        <button className="icon-btn" aria-label={t("Close")} onClick={onClose} disabled={busy}><X size={15} /></button>
      </div>
      <p className="sql-dialog-target" data-production={env === "production"}>{env === "production" && <span>{t("PROD")} · </span>}
        {connectionName} / {target}
      </p>
      {error && <pre className="error">{error}</pre>}
      {importing ? <>
        <div className="row">
          <button onClick={() => void chooseFile()} disabled={busy}><FileUp size={14} />{t("Choose CSV or JSON")}</button>
          {loaded && <span className="muted">{loaded.name} · {tf("{count} row(s)", { count: loaded.data.rows.length })}</span>}
        </div>
        {!loaded && <p className="muted small">{t("Import appends rows. CSV needs a header. Maximum 5 MiB and 5,000 rows.")}</p>}
        {loaded && <>
          <p className="muted small">{t("Map columns to import. Omitted columns use database defaults.")}</p>
          <div className="table-file-preview" tabIndex={0}>
            <table className="grid">
              <thead><tr>{loaded.data.columns.map((column, i) => <th key={column}>
                <label className="table-mapping">{column}
                  <select aria-label={tf("Destination for {name}", { name: column })} disabled={busy} value={mapping[i]}
                    onChange={(e) => setMapping((current) => current.map((entry, j) => j === i ? e.target.value : entry))}>
                    <option value="">{t("Skip column")}</option>
                    {columns.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
              </th>)}</tr></thead>
              <tbody>{loaded.data.rows.slice(0, 5).map((row, i) => <tr key={i}>
                {row.map((value, j) => <td className={value === null ? "null" : ""} key={j}>{value === null ? "NULL" : String(value)}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
          {mapped.length !== new Set(mapped).size && <p className="status bad">{t("Map each destination column only once.")}</p>}
        </>}
        <div className="actions"><span className="spacer" /><button className="primary" disabled={!loaded || !valid || busy} onClick={() => void applyImport()}>{t(busy ? "Working…" : "Import")}</button></div>
      </> : <>
        <p className="muted">{t("Export the entire table, without filters or pending grid edits.")}</p>
        <label className="row">{t("Export format")} <select value={format} disabled={busy} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
          <option value="csv">CSV</option><option value="json">JSON</option>
        </select></label>
        <div className="actions">
          <span className="spacer" />
          {canStop && <button onClick={() => cancel.current?.()}>{t("Cancel export")}</button>}
          <button className="primary" disabled={busy} onClick={() => void applyExport()}><FileDown size={14} />{t(busy ? "Exporting…" : "Export")}</button>
        </div>
      </>}
    </div>
  </div>;
}
