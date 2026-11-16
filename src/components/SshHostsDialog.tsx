import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { FileCode, FolderOpen, Plus, RefreshCw, Save, Server, Trash2, X, Zap } from "lucide-react";
import { errText, type ConnectionConfig } from "../api";
import { useToast } from "./Toast";
import { inEditor } from "../settings";
import { CodeEditor } from "./CodeEditor";

interface HostForm {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  identityFile: string;
  proxyJump: string;
}

interface HostBlock extends HostForm {
  pattern: boolean;
  other: string[];
  comments: string[];
}

const EMPTY: HostForm = { alias: "", hostName: "", user: "", port: "", identityFile: "", proxyJump: "" };

interface Props {
  conns: ConnectionConfig[];
  onClose: () => void;
  /** Hosts changed: connection forms should reload their list. */
  onChanged?: () => void;
}

/** Manage ~/.ssh/config: list, edit, add, delete and test Host blocks, or edit the raw file. */
export function SshHostsDialog({ conns, onClose, onChanged }: Props) {
  const toast = useToast();
  const [hosts, setHosts] = useState<HostBlock[]>([]);
  const [sel, setSel] = useState<string | null>(null); // alias, "" = new
  const [form, setForm] = useState<HostForm>(EMPTY);
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const h = await invoke<HostBlock[]>("ssh_hosts_list");
      setHosts(h);
      return h;
    } catch (e) {
      toast("error", errText(e));
      return [];
    }
  }, [toast]);

  useEffect(() => {
    void load().then((h) => {
      const first = h.find((x) => !x.pattern);
      if (first) pick(first);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const usedBy = useMemo(() => {
    const m = new Map<string, ConnectionConfig[]>();
    for (const c of conns) if (c.ssh.enabled && c.ssh.host) m.set(c.ssh.host, [...(m.get(c.ssh.host) ?? []), c]);
    return m;
  }, [conns]);

  const pick = (h: HostBlock) => {
    setRaw(null);
    setSel(h.alias);
    setForm({ alias: h.alias, hostName: h.hostName, user: h.user, port: h.port, identityFile: h.identityFile, proxyJump: h.proxyJump });
  };
  const current = hosts.find((h) => h.alias === sel);
  const set = (k: keyof HostForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = sel === "" ? !!form.alias : !!current && (Object.keys(EMPTY) as (keyof HostForm)[]).some((k) => form[k] !== current[k]);

  const save = async () => {
    setBusy(true);
    try {
      await invoke("ssh_host_save", { original: sel || null, form });
      toast("ok", `Saved ${form.alias} to ~/.ssh/config (backup kept next to it)`);
      const h = await load();
      const now = h.find((x) => x.alias === form.alias);
      if (now) pick(now);
      onChanged?.();
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!current) return;
    const users = usedBy.get(current.alias)?.length ?? 0;
    const msg = `Delete Host ${current.alias} from ~/.ssh/config?` + (users ? `\n\n${users} dbdock connection(s) use it and will stop resolving.` : "") + "\n\nA backup of the file is kept.";
    if (!(await ask(msg, { title: "Delete SSH host", kind: "warning" }))) return;
    try {
      await invoke("ssh_host_delete", { alias: current.alias });
      toast("ok", `Deleted ${current.alias}`);
      const h = await load();
      const first = h.find((x) => !x.pattern);
      if (first) pick(first);
      else {
        setSel("");
        setForm(EMPTY);
      }
      onChanged?.();
    } catch (e) {
      toast("error", errText(e));
    }
  };

  const test = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      toast("ok", `${sel}: ${await invoke<string>("ssh_host_test", { alias: sel })}`);
    } catch (e) {
      toast("error", `${sel}: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const editRaw = async () => {
    try {
      setRaw(await invoke<string>("ssh_config_raw"));
      setSel(null);
    } catch (e) {
      toast("error", errText(e));
    }
  };

  const saveRaw = async () => {
    if (raw === null) return;
    setBusy(true);
    try {
      await invoke("ssh_config_write", { text: raw });
      toast("ok", "Saved ~/.ssh/config (backup kept next to it)");
      await load();
      onChanged?.();
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setBusy(false);
    }
  };

  const pickKey = async () => {
    const f = await open({ multiple: false, defaultPath: "~/.ssh" });
    if (typeof f === "string") set("identityFile", f.replace(/^\/Users\/[^/]+/, "~"));
  };

  const q = query.toLowerCase();
  const shown = hosts.filter((h) => `${h.alias} ${h.hostName} ${h.user}`.toLowerCase().includes(q));

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal ssh-hosts" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <Server size={16} /> SSH Hosts <span className="muted small">~/.ssh/config</span>
          </h2>
          <div className="row">
            <button className="icon-btn" onClick={() => void load()} title="Reload">
              <RefreshCw size={14} />
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="ssh-hosts-body">
          <aside className="ssh-hosts-list">
            <input className="search" placeholder="Filter hosts" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul className="list">
              {shown.map((h) => (
                <li key={h.alias} className={sel === h.alias ? "on" : ""} onClick={() => (h.pattern ? void editRaw() : pick(h))} title={h.pattern ? "Pattern block — edit in the raw file" : undefined}>
                  <Server size={14} className="icon" />
                  <div className="host-text">
                    <b>{h.alias}</b>
                    <span className="muted small">
                      {h.pattern ? "pattern · raw only" : `${h.user ? `${h.user}@` : ""}${h.hostName || h.alias}${h.port ? `:${h.port}` : ""}`}
                    </span>
                  </div>
                  {!!usedBy.get(h.alias)?.length && <span className="count" title="dbdock connections using this host">{usedBy.get(h.alias)!.length}</span>}
                </li>
              ))}
              {!shown.length && <li className="muted">No hosts</li>}
            </ul>
            <div className="row">
              <button
                onClick={() => {
                  setRaw(null);
                  setSel("");
                  setForm(EMPTY);
                }}
              >
                <Plus size={14} /> New host
              </button>
              <button onClick={() => void editRaw()} className={raw !== null ? "on-btn" : ""}>
                <FileCode size={14} /> Raw file
              </button>
            </div>
          </aside>

          <section className="ssh-hosts-edit">
            {raw !== null ? (
              <>
                <div className="raw-config">
                  <CodeEditor value={raw} onChange={setRaw} onSave={() => void saveRaw()} autoFocus />
                </div>
                <div className="actions">
                  <span className="muted small">The whole file, saved as is. A timestamped backup is written first.</span>
                  <span className="spacer" />
                  <button className="primary" disabled={busy} onClick={() => void saveRaw()}>
                    <Save size={14} /> Save file
                  </button>
                </div>
              </>
            ) : sel !== null ? (
              <>
                <div className="form">
                  <label>Host</label>
                  <input value={form.alias} onChange={(e) => set("alias", e.target.value)} placeholder="alias, e.g. bastion" spellCheck={false} autoFocus={sel === ""} />
                  <label>HostName</label>
                  <input value={form.hostName} onChange={(e) => set("hostName", e.target.value)} placeholder="IP or DNS name (empty = the alias)" spellCheck={false} />
                  <label>User</label>
                  <input value={form.user} onChange={(e) => set("user", e.target.value)} placeholder="login user" spellCheck={false} />
                  <label>Port</label>
                  <input className="port" value={form.port} onChange={(e) => set("port", e.target.value)} placeholder="22" spellCheck={false} />
                  <label>IdentityFile</label>
                  <div className="row">
                    <input value={form.identityFile} onChange={(e) => set("identityFile", e.target.value)} placeholder="~/.ssh/id_ed25519 (empty = agent / defaults)" spellCheck={false} />
                    <button onClick={() => void pickKey()}>
                      <FolderOpen size={14} />
                    </button>
                  </div>
                  <label>ProxyJump</label>
                  <input value={form.proxyJump} onChange={(e) => set("proxyJump", e.target.value)} placeholder="jump host alias (used by ssh; dbdock tunnels do not follow it yet)" spellCheck={false} />
                </div>
                {current && (current.other.length > 0 || current.comments.length > 0) && (
                  <div className="kept-lines">
                    <span className="muted small">Kept as is</span>
                    <pre>{[...current.other, ...current.comments].join("\n")}</pre>
                  </div>
                )}
                {current && !!usedBy.get(current.alias)?.length && (
                  <p className="hint">Used by: {usedBy.get(current.alias)!.map((c) => c.name).join(", ")}</p>
                )}
                <div className="actions">
                  {current && (
                    <button className="danger" onClick={() => void del()}>
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                  {current && (
                    <button onClick={() => void test()} disabled={busy || dirty} title={dirty ? "Save first" : "Log in with agent / key"}>
                      <Zap size={14} /> Test login
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="primary" disabled={busy || !dirty || !form.alias.trim()} onClick={() => void save()}>
                    <Save size={14} /> {sel === "" ? "Add host" : "Save"}
                  </button>
                </div>
              </>
            ) : (
              <div className="grid-empty muted">Pick a host, or add one.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
