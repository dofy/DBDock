import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Eye, Plus, Trash2, X } from "lucide-react";
import { api, errText, type ColumnDraft, type ColumnType, type Kind, type SchemaChange, type SqlProtection } from "../api";
import { t, tf } from "../i18n";

const TYPES: [ColumnType, string][] = [
  ["integer", "INTEGER"], ["bigint", "BIGINT"], ["text", "TEXT"], ["varchar", "VARCHAR(255)"],
  ["decimal", "DECIMAL(18, 6)"], ["real", "Real number"], ["boolean", "Boolean"],
  ["date", "DATE"], ["timestamp", "Timestamp"], ["json", "JSON"], ["binary", "Binary data"],
];
const blank = (): ColumnDraft => ({ name: "", dataType: "text", notNull: false, primaryKey: false, defaultValue: null });

function TypePicker({ value, onChange }: { value: ColumnType; onChange: (type: ColumnType) => void }) {
  return <select aria-label={t("Data type")} value={value} onChange={(e) => onChange(e.target.value as ColumnType)}>
    {TYPES.map(([type, label]) => <option value={type} key={type}>{t(label)}</option>)}
  </select>;
}

function ColumnFields({ value, set, create, remove }: {
  value: ColumnDraft;
  set: (value: ColumnDraft) => void;
  create: boolean;
  remove?: () => void;
}) {
  return <div className="schema-column">
    <input aria-label={t("Column name")} placeholder={t("Column name")} required value={value.name}
      onChange={(e) => set({ ...value, name: e.target.value })} />
    <TypePicker value={value.dataType} onChange={(dataType) => set({ ...value, dataType })} />
    <label className="row">
      <input type="checkbox" checked={value.notNull || value.primaryKey} disabled={value.primaryKey}
        onChange={(e) => set({ ...value, notNull: e.target.checked })} /> NOT NULL
    </label>
    {create && <label className="row">
      <input type="checkbox" checked={value.primaryKey} onChange={(e) => set({ ...value, primaryKey: e.target.checked })} /> {t("Primary key")}
    </label>}
    <label className="row">
      <input type="checkbox" checked={value.defaultValue !== null} onChange={(e) => set({ ...value, defaultValue: e.target.checked ? "" : null })} /> {t("Default value")}
    </label>
    {value.defaultValue !== null && <input aria-label={t("Default value")} value={value.defaultValue} onChange={(e) => set({ ...value, defaultValue: e.target.value })} />}
    {remove && <button type="button" className="icon-btn" title={t("Remove column")} onClick={remove}><Trash2 size={14} /></button>}
  </div>;
}

export interface TableActionTarget {
  sessionId: string;
  schema: string;
  connectionName: string;
}

interface Props extends TableActionTarget {
  kind: Kind;
  protection: SqlProtection;
  table?: string;
  columns?: string[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onApplied: (table: string) => void;
}

type Alter = Exclude<SchemaChange["op"], "create">;

export function SchemaEditor({ sessionId, schema, connectionName, kind, protection, table, columns = [], onClose, onBusy, onApplied }: Props) {
  const create = table === undefined;
  const [name, setName] = useState(table ?? "");
  const [drafts, setDrafts] = useState<ColumnDraft[]>([blank()]);
  const [op, setOp] = useState<Alter>("add");
  const [column, setColumn] = useState(columns[0] ?? "");
  const [newName, setNewName] = useState("");
  const [dataType, setDataType] = useState<ColumnType>("text");
  const [notNull, setNotNull] = useState(true);
  const [setDefault, setSetDefault] = useState(true);
  const [defaultValue, setDefaultValue] = useState("");
  const [preview, setPreview] = useState<{ sql: string; target: string; change: SchemaChange }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actions: [Alter, string][] = [["add", "Add column"], ["rename", "Rename column"], ["drop", "Drop column"]];
  if (kind === "postgres") actions.push(["type", "Change type"], ["nullability", "Change nullability"]);
  if (kind === "postgres" || kind === "mysql") actions.push(["default", "Change default"]);

  const draftChange = (): SchemaChange => {
    if (create) return { op: "create", columns: drafts };
    switch (op) {
      case "add": return { op, column: drafts[0] };
      case "rename": return { op, column, newName: newName.trim() };
      case "drop": return { op, column };
      case "type": return { op, column, dataType };
      case "nullability": return { op, column, notNull };
      case "default": return { op, column, value: setDefault ? defaultValue : null };
    }
  };

  const showPreview = async () => {
    const change = draftChange();
    const target = name.trim();
    setBusy(true);
    setError("");
    try {
      const sql = await api.previewSchema(sessionId, schema, target, change);
      setPreview({ sql, target, change });
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!preview || busy) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const destructive = preview.change.op === "drop";
      const confirmed = destructive || protection === "confirm";
      if (confirmed) {
        const prompt = preview.change.op === "drop"
          ? tf("Drop {column} and its data from {table}?", { column: preview.change.column, table: `${schema}.${preview.target}` })
          : tf("Apply this schema change on {name}?", { name: connectionName });
        if (!(await ask(prompt + "\n\n" + preview.sql, { title: t("Confirm schema change"), kind: "warning", okLabel: t("Apply"), cancelLabel: t("Cancel") }))) return;
      }
      await api.applySchema(sessionId, schema, preview.target, preview.change, confirmed);
      onApplied(preview.target);
    } catch (e) { setError(errText(e)); }
    finally { onBusy(false); setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
    <div className="modal wide table-tool" role="dialog" aria-modal="true" aria-label={t(create ? "New table" : "Edit structure")} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h2>{t(create ? "New table" : "Edit structure")}</h2>
        <button className="icon-btn" aria-label={t("Close")} disabled={busy} onClick={onClose}><X size={15} /></button>
      </div>
      <p className="muted">{connectionName} / {schema}{table ? `.${table}` : ""}</p>
      {error && <pre className="error">{error}</pre>}
      {preview ? <>
        <pre className="sql-preview">{preview.sql};</pre>
        <div className="actions">
          <button disabled={busy} onClick={() => setPreview(undefined)}>{t("Back")}</button>
          <span className="spacer" />
          <button className={preview.change.op === "drop" ? "danger" : "primary"} disabled={busy} onClick={() => void apply()}>{t(busy ? "Applying…" : "Apply")}</button>
        </div>
      </> : <form onSubmit={(e) => { e.preventDefault(); if (!busy) void showPreview(); }}>
        <fieldset disabled={busy}>
          {create ? <label className="row">{t("Table name")} <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} /></label>
            : <label className="row">{t("Operation")} <select value={op} onChange={(e) => setOp(e.target.value as Alter)}>
              {actions.map(([key, label]) => <option value={key} key={key}>{t(label)}</option>)}
            </select></label>}
          {(create || op === "add") ? <>
            {drafts.map((value, i) => <ColumnFields key={i} create={create} value={value}
              set={(column) => setDrafts((current) => current.map((entry, j) => i === j ? column : entry))}
              remove={create && drafts.length > 1 ? () => setDrafts((current) => current.filter((_, j) => i !== j)) : undefined} />)}
            {create && <button type="button" onClick={() => setDrafts((current) => [...current, blank()])} disabled={drafts.length >= 100}><Plus size={14} />{t("Add column")}</button>}
          </> : <div className="schema-column">
            <select aria-label={t("Column")} value={column} onChange={(e) => setColumn(e.target.value)}>
              {columns.map((item) => <option key={item}>{item}</option>)}
            </select>
            {op === "rename" && <input aria-label={t("New column name")} placeholder={t("New column name")} required value={newName} onChange={(e) => setNewName(e.target.value)} />}
            {op === "type" && <TypePicker value={dataType} onChange={setDataType} />}
            {op === "nullability" && <label className="row"><input type="checkbox" checked={notNull} onChange={(e) => setNotNull(e.target.checked)} /> NOT NULL</label>}
            {op === "default" && <>
              <label className="row"><input type="checkbox" checked={setDefault} onChange={(e) => setSetDefault(e.target.checked)} /> {t("Set default value")}</label>
              {setDefault && <input aria-label={t("Default value")} value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} />}
            </>}
          </div>}
        </fieldset>
        <div className="actions">
          <span className="spacer" />
          <button className="primary" disabled={busy || (!create && op !== "add" && !column)}><Eye size={14} />{t("Preview SQL")}</button>
        </div>
      </form>}
    </div>
  </div>;
}
