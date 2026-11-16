import { t, tf } from "../i18n";
import { useEffect, useState } from "react";
import { inEditor } from "../settings";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "./Toast";
import { ArrowRight, BookUser, Server } from "lucide-react";

interface SshHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}
import { DbIcon } from "./DbIcon";
import { api, blankConnection, DEFAULT_PORT, isTunnelable, ENV_LABEL, ENVS, errText, KIND_LABEL, type ConnectionConfig, type Kind, type SecretsInput } from "../api";
import { FolderOpen, Save, Zap } from "lucide-react";

interface Props {
  initial?: ConnectionConfig;
  /** Group for a new connection. */
  initialGroup?: string;
  groups: string[];
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
}

const KINDS: Kind[] = ["mysql", "postgres", "sqlite", "redis", "mongodb", "d1"];

export function ConnectionForm({ initial, initialGroup, groups, onClose, onSaved }: Props) {
  const editing = !!initial?.id;
  const [c, setC] = useState<ConnectionConfig>(initial ?? { ...blankConnection(), group: initialGroup ?? "" });
  // Secrets are never read back from the keychain into the form.
  const [secrets, setSecrets] = useState<SecretsInput>({});
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inEditor(e) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setC((p) => ({ ...p, [k]: v }));
  const setSsh = <K extends keyof ConnectionConfig["ssh"]>(k: K, v: ConnectionConfig["ssh"][K]) =>
    setC((p) => ({ ...p, ssh: { ...p.ssh, [k]: v } }));

  const changeKind = (kind: Kind) => {
    const b = blankConnection(kind);
    setC((p) => ({ ...p, kind, port: DEFAULT_PORT[kind], user: p.user || b.user, host: kind === "sqlite" || kind === "d1" ? "" : p.host || b.host }));
  };

  const pickFile = async () => {
    const f = await open({ multiple: false, filters: [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db", "db3"] }, { name: "All", extensions: ["*"] }] });
    if (typeof f === "string") {
      set("file", f);
      if (!c.name) set("name", f.split("/").pop() ?? f);
    }
  };

  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [hostMenu, setHostMenu] = useState(false);
  useEffect(() => {
    invoke<SshHost[]>("ssh_config_hosts").then(setHosts).catch(() => {});
  }, []);
  const alias = hosts.find((h) => h.alias === c.ssh.host.trim());
  const isAlias = !!alias;
  // A raw host/user that some ~/.ssh/config alias already describes (e.g. after an import).
  const suggest = !alias && c.ssh.host.trim()
    ? hosts.find((h) => h.hostName === c.ssh.host.trim() && (!c.ssh.user || !h.user || h.user === c.ssh.user) && (h.port ?? 22) === (c.ssh.port || 22))
    : undefined;
  const pickAlias = (h: SshHost) => {
    setHostMenu(false);
    // Keep only what the form overrides; the rest comes from ~/.ssh/config at connect time.
    setC((p) => ({ ...p, ssh: { ...p.ssh, host: h.alias, user: p.ssh.user && p.ssh.user !== h.user ? p.ssh.user : "", port: 22, auth: "key", keyPath: "" } }));
    setWantFile(false);
  };

  // "auto" = key auth without a file (agent, ~/.ssh/config, defaults).
  const [wantFile, setWantFile] = useState(!!c.ssh.keyPath);
  const keyMode = c.ssh.auth === "password" ? "password" : wantFile || c.ssh.keyPath ? "file" : "auto";
  const chooseKeyMode = (m: "auto" | "file" | "password") => {
    setWantFile(m === "file");
    setC((p) => ({ ...p, ssh: { ...p.ssh, auth: m === "password" ? "password" : "key", keyPath: m === "file" ? p.ssh.keyPath : "" } }));
  };

  const pickKey = async () => {
    const f = await open({ multiple: false, defaultPath: "~/.ssh" });
    if (typeof f === "string") setSsh("keyPath", f);
  };

  const named = (): ConnectionConfig => ({
    ...c,
    name:
      c.name.trim() ||
      (c.kind === "sqlite" ? c.file.split("/").pop() || "SQLite" : c.kind === "d1" ? `D1 ${c.database.slice(0, 8)}` : `${c.host}:${c.port}`),
  });

  const test = async () => {
    setBusy(true);
    try {
      const v = await api.testConnection(named(), secrets);
      toast("ok", tf("Connected · {version}", { version: v }));
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.saveConnection(named(), secrets));
    } catch (e) {
      toast("error", errText(e));
      setBusy(false);
    }
  };

  const pwPlaceholder = editing ? t("unchanged (saved in Keychain)") : "";
  const network = isTunnelable(c.kind);
  const mongoUri = c.kind === "mongodb" && c.host.trim().startsWith("mongodb");

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{editing ? t("Edit connection") : t("New connection")}</h2>

        <div className="kind-picker">
          {KINDS.map((k) => (
            <button key={k} className={`kind-btn ${c.kind === k ? "active" : ""}`} onClick={() => changeKind(k)}>
              <DbIcon kind={k} size={30} />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="form">
          <label>{t("Name")}</label>
          <input value={c.name} onChange={(e) => set("name", e.target.value)} placeholder={t("optional")} />

          <label>{t("Environment")}</label>
          <div className="env-picker">
            <button className={`env-opt env-none ${!c.env ? "on" : ""}`} aria-pressed={!c.env} onClick={() => set("env", "")}>
               {t("none")} </button>
            {ENVS.map((e) => (
              <button key={e} className={`env-opt env-${e} ${c.env === e ? "on" : ""}`} aria-pressed={c.env === e} onClick={() => set("env", e)}>
                {t(ENV_LABEL[e])}
              </button>
            ))}
          </div>
          <label>{t("Group")}</label>
          <input value={c.group} onChange={(e) => set("group", e.target.value)} placeholder={t("Ungrouped — pick or type a new path")} list="group-options" spellCheck={false} />
          <datalist id="group-options">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>

          {c.kind === "d1" ? (
            <>
              <label>{t("Account ID")}</label>
              <input value={c.cfAccountId} onChange={(e) => set("cfAccountId", e.target.value.trim())} placeholder="dash.cloudflare.com → Workers & Pages → Account ID" spellCheck={false} />
              <label>{t("Database ID")}</label>
              <input value={c.database} onChange={(e) => set("database", e.target.value.trim())} placeholder={t("UUID, see `wrangler d1 list` or wrangler.jsonc")} spellCheck={false} />
              <label>{t("API token")}</label>
              <input
                type="password"
                value={secrets.password ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, password: e.target.value }))}
                placeholder={editing ? t("unchanged (saved in Keychain)") : t("token with D1 Edit permission")}
              />
              <p className="hint">{t("Queries go through the Cloudflare REST API. D1 cannot cancel a running query.")}</p>
            </>
          ) : network ? (
            <>
              <label>{t("Host")}</label>
              <div className="row">
                <input
                  value={c.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder={c.kind === "mongodb" ? "127.0.0.1, or a mongodb:// / mongodb+srv:// URI" : "127.0.0.1"}
                  spellCheck={false}
                />
                {!mongoUri && <input className="port" type="number" value={c.port || ""} onChange={(e) => set("port", Number(e.target.value))} />}
              </div>
              <label>{t("User")}</label>
              <input value={c.user} onChange={(e) => set("user", e.target.value)} placeholder={c.kind === "redis" ? t("default (ACL user, optional)") : ""} />
              <label>{t("Password")}</label>
              <input
                type="password"
                value={secrets.password ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, password: e.target.value }))}
                placeholder={pwPlaceholder}
              />
              {c.kind === "redis" ? (
                <>
                  <label>{t("Database")}</label>
                  <input type="number" min={0} value={c.redisDb} onChange={(e) => set("redisDb", Number(e.target.value))} />
                </>
              ) : c.kind === "mongodb" ? (
                !mongoUri && (
                  <>
                    <label>{t("Database")}</label>
                    <input value={c.database} onChange={(e) => set("database", e.target.value)} placeholder={t("default database (optional)")} spellCheck={false} />
                    <label>{t("Options")}</label>
                    <input value={c.options} onChange={(e) => set("options", e.target.value)} placeholder="authSource=admin&tls=true" spellCheck={false} />
                  </>
                )
              ) : (
                <>
                  <label>{t("Database")}</label>
                  <input value={c.database} onChange={(e) => set("database", e.target.value)} placeholder={c.kind === "postgres" ? "postgres" : t("optional")} />
                </>
              )}
              {mongoUri && <p className="hint">{t("User and password above override the ones in the URI when filled. With SSH, use host and port instead of a URI.")}</p>}
            </>
          ) : (
            <>
              <label>{t("File")}</label>
              <div className="row">
                <input value={c.file} onChange={(e) => set("file", e.target.value)} placeholder="/path/to/db.sqlite" />
                <button onClick={pickFile}><FolderOpen size={14} />{t("Choose…")}</button>
              </div>
            </>
          )}
        </div>

        {network && (
          <section className={`ssh-card ${c.ssh.enabled ? "on" : ""}`}>
            <label className="ssh-head">
              <span className="switch">
                <input type="checkbox" checked={c.ssh.enabled} onChange={(e) => setSsh("enabled", e.target.checked)} />
                <span />
              </span>
              <b>{t("Over SSH")}</b>
              <span className="muted small">
                {c.ssh.enabled ? (c.ssh.host ? `via ${c.ssh.user ? `${c.ssh.user}@` : ""}${c.ssh.host}${c.ssh.port && c.ssh.port !== 22 ? `:${c.ssh.port}` : ""}` : t("tunnel through a bastion / jump host")) : t("connect directly")}
              </span>
            </label>
            {c.ssh.enabled && (
              <div className="form ssh-body">
                <label>{t("Server")}</label>
                <div className="row host-row">
                  <input value={c.ssh.host} onChange={(e) => setSsh("host", e.target.value)} placeholder={t("host, IP, or ~/.ssh/config alias")} spellCheck={false} />
                  <input className="port" type="number" value={c.ssh.port || ""} onChange={(e) => setSsh("port", Number(e.target.value))} placeholder="22" />
                  <button onClick={() => setHostMenu((v) => !v)} disabled={!hosts.length} title={hosts.length ? t("Pick a Host from ~/.ssh/config") : t("No hosts in ~/.ssh/config")}>
                    <BookUser size={14} />  {t("Hosts")} </button>
                  {hostMenu && (
                    <div className="host-menu" onMouseLeave={() => setHostMenu(false)}>
                      {hosts.map((h) => (
                        <button key={h.alias} className={h.alias === c.ssh.host ? "on" : ""} onClick={() => pickAlias(h)}>
                          <Server size={14} />
                          <b>{h.alias}</b>
                          <span className="muted">
                            {h.user ? `${h.user}@` : ""}
                            {h.hostName ?? h.alias}
                            {h.port && h.port !== 22 ? `:${h.port}` : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {alias && (
                  <p className="hint resolved">
                    <ArrowRight size={12} /> {c.ssh.user || alias.user || "?"}@{alias.hostName ?? alias.alias}:{c.ssh.port && c.ssh.port !== 22 ? c.ssh.port : (alias.port ?? 22)}
                    {alias.identityFile && keyMode === "auto" ? ` · key ${alias.identityFile}` : ""}  {t("— from ~/.ssh/config")} </p>
                )}
                {suggest && (
                  <p className="hint resolved">
                     {t("This is")} <b>{suggest.alias}</b>  {t("in ~/.ssh/config.")}{" "}
                    <button className="link" onClick={() => pickAlias(suggest)}>
                       {t("Use the alias")} </button>{" "}
                     {t("so later edits to the config apply here too.")} </p>
                )}
                <label>{t("User")}</label>
                <input value={c.ssh.user} onChange={(e) => setSsh("user", e.target.value)} placeholder={isAlias ? t("from ~/.ssh/config") : t("user name")} spellCheck={false} />
                <label>{t("Auth")}</label>
                <div className="seg">
                  <button className={keyMode === "auto" ? "on" : ""} onClick={() => chooseKeyMode("auto")} title={t("ssh-agent, then IdentityFile from ~/.ssh/config, then ~/.ssh/id_*")}>
                    Agent / ~/.ssh
                  </button>
                  <button className={keyMode === "file" ? "on" : ""} onClick={() => chooseKeyMode("file")}>
                     {t("Key file")} </button>
                  <button className={keyMode === "password" ? "on" : ""} onClick={() => chooseKeyMode("password")}>
                     {t("Password")} </button>
                </div>
                {keyMode === "auto" && (
                  <p className="hint">{t("Tries ssh-agent, then IdentityFile from ~/.ssh/config, then ~/.ssh/id_ed25519, id_ecdsa, id_rsa.")}</p>
                )}
                {keyMode === "file" && (
                  <>
                    <label>{t("Key file")}</label>
                    <div className="row">
                      <input value={c.ssh.keyPath} onChange={(e) => setSsh("keyPath", e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
                      <button onClick={pickKey}><FolderOpen size={14} />{t("Choose…")}</button>
                    </div>
                  </>
                )}
                {keyMode !== "password" && (
                  <>
                    <label>{t("Passphrase")}</label>
                    <input
                      type="password"
                      value={secrets.sshPassphrase ?? ""}
                      onChange={(e) => setSecrets((s) => ({ ...s, sshPassphrase: e.target.value }))}
                      placeholder={editing ? t("unchanged") : t("only if the key file is encrypted")}
                    />
                  </>
                )}
                {keyMode === "password" && (
                  <>
                    <label>{t("Password")}</label>
                    <input
                      type="password"
                      value={secrets.sshPassword ?? ""}
                      onChange={(e) => setSecrets((s) => ({ ...s, sshPassword: e.target.value }))}
                      placeholder={pwPlaceholder}
                    />
                  </>
                )}
                <p className="hint">{t("Host and port above are reached from the SSH server, e.g. 127.0.0.1 for a database on that machine, or a private RDS endpoint.")}</p>
              </div>
            )}
          </section>
        )}


        <div className="actions">
          <button onClick={test} disabled={busy}>
            <Zap size={14} />{t("Test")} </button>
          <span className="spacer" />
          <button onClick={onClose}>{t("Cancel")}</button>
          <button className="primary" onClick={save} disabled={busy || (c.kind === "sqlite" && !c.file) || (c.kind === "d1" && (!c.cfAccountId || !c.database))}>
            <Save size={14} />{t("Save")} </button>
        </div>
      </div>
    </div>
  );
}
