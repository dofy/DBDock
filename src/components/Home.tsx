import { t, tf } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, ENV_LABEL, ENVS, errText, type ConnectionConfig } from "../api";
import { DbIcon } from "./DbIcon";
import { PromptDialog } from "./Dialogs";
import { useToast } from "./Toast";
import { TransferDialog } from "./TransferDialog";
import { ImportDialog, type ImportReport } from "./ImportDialog";
import { SshHostsDialog } from "./SshHostsDialog";
import { HealthDialog } from "./HealthDialog";
import { Activity, Check, Database, FileUp, Folder, FolderInput, FolderPlus, Inbox, ListChecks, MoreHorizontal, PenLine, Pencil, Plug, Plus, SquareCheck, SquareMinus, Trash2, X } from "lucide-react";

const SEP = " / ";
/** null = all connections, "" = ungrouped, otherwise a group path (includes subgroups). */
type GroupSel = string | null;

const within = (g: string, root: string) => g === root || g.startsWith(root + SEP);
const leaf = (g: string) => g.split(SEP).pop() ?? g;
const depth = (g: string) => g.split(SEP).length - 1;

export function EnvBadge({ env }: { env: string }) {
  if (!env) return null;
  return <span className={`env-badge env-${env}`}>{t(ENV_LABEL[env] ?? env.toUpperCase())}</span>;
}

function target(c: ConnectionConfig) {
  if (c.kind === "sqlite") return c.file;
  if (c.kind === "d1") return `D1 · ${c.database.slice(0, 8)}… · account ${c.cfAccountId.slice(0, 6)}…`;
  if (c.kind === "mongodb" && c.host.startsWith("mongodb")) return c.host.replace(/\/\/[^@/]*@/, "//");
  return `${c.user ? `${c.user}@` : ""}${c.host}:${c.port}${c.kind === "redis" ? `/${c.redisDb}` : c.database ? `/${c.database}` : ""}`;
}

type Dialog =
  | { kind: "new-group"; parent: string }
  | { kind: "rename-group"; path: string }
  | { kind: "delete-group"; path: string }
  | { kind: "move"; ids: string[] }
  | { kind: "export"; ids?: string[] }
  | { kind: "import"; paste?: boolean }
  | { kind: "ssh-hosts" }
  | { kind: "health"; connections: ConnectionConfig[] };

export interface MenuAction {
  id: string;
  /** Changes on every menu click so repeated clicks fire again. */
  seq: number;
}

interface Props {
  action?: MenuAction | null;
  conns: ConnectionConfig[];
  groups: string[];
  reload: () => Promise<void>;
  connecting: string | null;
  onConnect: (c: ConnectionConfig) => void;
  onEdit: (c: ConnectionConfig | { newInGroup: string }) => void;
}

export function Home({ conns, groups, reload, connecting, onConnect, onEdit, action }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [envFilter, setEnvFilter] = useState<string | null>(null);
  const [sel, setSel] = useState<GroupSel>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | { group: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Native menu actions that belong to the home screen.
  useEffect(() => {
    if (!action) return;
    switch (action.id) {
      case "import":
        return setDialog({ kind: "import" });
      case "import-urls":
        return setDialog({ kind: "import", paste: true });
      case "export":
        return setDialog({ kind: "export", ids: picked.size ? [...picked] : undefined });
      case "ssh-hosts":
        return setDialog({ kind: "ssh-hosts" });
      case "new-group":
        return setDialog({ kind: "new-group", parent: sel && sel !== "" ? sel : "" });
      case "find":
        return searchRef.current?.focus();
      case "reload":
        void reload();
        return;
    }
    // Only react to new actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action?.seq]);

  // Forget a selected group that no longer exists.
  useEffect(() => {
    if (sel && !groups.includes(sel)) setSel(null);
  }, [groups, sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !dialog) setPicked(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast("ok", ok);
      await reload();
    } catch (e) {
      toast("error", errText(e));
    }
  };

  const groupCount = (g: string) => conns.filter((c) => within(c.group, g)).length;
  const ungrouped = conns.filter((c) => !c.group).length;

  const inGroup = conns.filter((c) => (sel === null ? true : sel === "" ? !c.group : within(c.group, sel)));
  const envCounts = new Map<string, number>();
  for (const c of inGroup) envCounts.set(c.env || "", (envCounts.get(c.env || "") ?? 0) + 1);
  const q = query.trim().toLowerCase();
  const shown = inGroup.filter(
    (c) => (envFilter === null || (c.env || "") === envFilter) && (!q || `${c.group} ${c.name} ${c.env} ${c.kind} ${target(c)} ${c.ssh.enabled ? c.ssh.host : ""}`.toLowerCase().includes(q)),
  );

  const sections = useMemo(() => {
    const m = new Map<string, ConnectionConfig[]>();
    for (const c of [...shown].sort((a, b) => (a.group || "￿").localeCompare(b.group || "￿") || a.name.localeCompare(b.name)))
      m.set(c.group || "", [...(m.get(c.group || "") ?? []), c]);
    return [...m.entries()];
  }, [shown]);

  // Tree rows: hide children of collapsed groups.
  const treeRows = groups.filter((g) => !groups.some((p) => p !== g && within(g, p) && collapsed.has(p)));
  const hasChildren = (g: string) => groups.some((x) => x !== g && within(x, g));

  const togglePick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const deleteConnections = async (ids: string[]) => {
    const names = conns.filter((c) => ids.includes(c.id)).map((c) => c.name);
    const msg = ids.length === 1 ? tf('Delete connection "{name}" and its saved passwords?', { name: names[0] }) : `${tf("Delete {count} connections and their saved passwords?", { count: ids.length })}\n\n${names.join(", ")}`;
    if (!(await ask(msg, { title: t("Delete"), kind: "warning" }))) return;
    await run(() => api.deleteConnections(ids), ids.length === 1 ? tf("Deleted {name}", { name: names[0] }) : tf("Deleted {count} connections", { count: ids.length }));
    setPicked(new Set());
  };

  const dropIds = (e: React.DragEvent): string[] => {
    try {
      return JSON.parse(e.dataTransfer.getData("application/x-dbdock-ids"));
    } catch {
      return [];
    }
  };

  const dropProps = (group: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("application/x-dbdock-ids")) {
        e.preventDefault();
        setDropTarget(group);
      }
    },
    onDragLeave: () => setDropTarget((t) => (t === group ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const ids = dropIds(e);
      if (ids.length) void run(() => api.moveConnections(ids, group), tf("Moved {count} to {group}", { count: ids.length, group: group || t("Ungrouped") })).then(() => setPicked(new Set()));
    },
  });

  const imported = (r: ImportReport) => {
    setDialog(null);
    const parts = [tf("{count} new", { count: r.added }), tf("{count} updated", { count: r.updated })];
    if (r.withSecrets) parts.push(tf("{count} with passwords", { count: r.withSecrets }));
    let msg = tf("Imported from {source}: {details}", { source: r.source.split(" · ")[0], details: parts.join(", ") });
    if (r.skipped.length) msg += `. ${tf("Skipped: {details}", { details: r.skipped.join(", ") })}`;
    if (r.passwordsNotImported) msg += `. ${t("Passwords are not readable from that app; enter each once.")}`;
    toast(r.skipped.length ? "info" : "ok", msg);
    void reload();
  };

  const title = sel === null ? t("All connections") : sel === "" ? t("Ungrouped") : sel;
  const pickedIds = [...picked];

  return (
    <div className="home-view">
      <aside className="home-side">
        <div className="search-box">
          <input ref={searchRef} className="search" placeholder={t("Search  ⌘F")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {query && (
            <button className="clear" onClick={() => setQuery("")} aria-label={t("Clear search")}>
              <X size={12} />
            </button>
          )}
        </div>
        <ul className="tree">
          <li className={`tree-row ${sel === null ? "on" : ""}`} onClick={() => setSel(null)}>
            <span className="tree-icon"><Database size={14} aria-hidden="true" /></span>
            <span className="tree-name">{t("All connections")}</span>
            <span className="count">{conns.length}</span>
          </li>
          <li className="tree-head">
            <span>{t("Groups")}</span>
            <button className="icon-btn" title={t("New group")} onClick={() => setDialog({ kind: "new-group", parent: sel && sel !== "" ? sel : "" })}>
              <FolderPlus size={14} />
            </button>
          </li>
          {treeRows.map((g) => (
            <li
              key={g}
              className={`tree-row ${sel === g ? "on" : ""} ${dropTarget === g ? "drop" : ""}`}
              style={{ paddingLeft: 8 + depth(g) * 14 }}
              onClick={() => setSel(g)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ group: g, x: e.clientX, y: e.clientY });
              }}
              {...dropProps(g)}
            >
              <button
                className={`caret ${hasChildren(g) ? "" : "none"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(g)) n.delete(g);
                    else n.add(g);
                    return n;
                  });
                }}
              >
                {collapsed.has(g) ? "▸" : "▾"}
              </button>
              <span className="tree-icon"><Folder size={14} aria-hidden="true" /></span>
              <span className="tree-name" title={g}>
                {leaf(g)}
              </span>
              <span className="count">{groupCount(g)}</span>
              <button
                className="icon-btn more"
                title={t("Group actions")}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu({ group: g, x: e.clientX, y: e.clientY });
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </li>
          ))}
          <li className={`tree-row ${sel === "" ? "on" : ""} ${dropTarget === "" ? "drop" : ""}`} onClick={() => setSel("")} {...dropProps("")}>
            <span className="caret none" />
            <span className="tree-icon"><Inbox size={14} aria-hidden="true" /></span>
            <span className="tree-name muted">{t("Ungrouped")}</span>
            <span className="count">{ungrouped}</span>
          </li>
        </ul>
        <p className="hint side-hint">{t("Drag connections onto a group to move them. Right-click a group for more.")}</p>
      </aside>

      <section className="home-main">
        <div className="home-head">
          <h1 title={title}>{title}</h1>
          <span className="muted">{shown.length}</span>
          <span className="spacer" />
          <button disabled={!shown.length} onClick={() => setDialog({ kind: "health", connections: [...shown] })}><Activity size={14} />{tf("Batch check shown ({count})", { count: shown.length })}</button>
          <button className="primary" onClick={() => onEdit({ newInGroup: sel ?? "" })}>
            <Plus size={14} />{t("New connection")} </button>
        </div>
        <div className="env-filter">
          <button className={`chip ${envFilter === null ? "on" : ""}`} onClick={() => setEnvFilter(null)}>
             {t("All")} {inGroup.length}
          </button>
          {[...ENVS, ""]
            .filter((e) => envCounts.has(e))
            .map((e) => (
              <button key={e || "none"} className={`chip env-chip env-${e || "none"} ${envFilter === e ? "on" : ""}`} onClick={() => setEnvFilter(envFilter === e ? null : e)}>
                {e ? t(ENV_LABEL[e]) : t("untagged")} {envCounts.get(e)}
              </button>
            ))}
        </div>

        {picked.size > 0 && (
          <div className="bulk-bar">
            <button className="icon-btn bulk-clear" onClick={() => setPicked(new Set())} title={t("Clear selection (Esc)")} aria-label={t("Clear selection")}>
              <X size={14} />
            </button>
            <b>{picked.size}  {t("selected")}</b>
            {picked.size < shown.length ? (
              <button className="link" onClick={() => setPicked(new Set(shown.map((c) => c.id)))}>
                 {t("Select all")} {shown.length}
              </button>
            ) : (
              <button className="link" onClick={() => setPicked(new Set())}>
                 {t("Select none")} </button>
            )}
            <span className="spacer" />
            <button onClick={() => setDialog({ kind: "health", connections: conns.filter((c) => picked.has(c.id)) })}><Activity size={14} />{tf("Check selected ({count})", { count: picked.size })}</button>
            <button onClick={() => setDialog({ kind: "move", ids: pickedIds })}><FolderInput size={14} />{t("Move to group…")}</button>
            <button onClick={() => setDialog({ kind: "export", ids: pickedIds })}><FileUp size={14} />{t("Export…")}</button>
            <button className="danger" onClick={() => void deleteConnections(pickedIds)}>
              <Trash2 size={14} />{t("Delete")} </button>
            <button onClick={() => setPicked(new Set())} title="Esc">
              <X size={14} />
               {t("Clear selection")} </button>
          </div>
        )}

        <div
          className="home-scroll"
          onClick={(e) => {
            // Clicks on the background (not on a card or a section title) clear the selection.
            if (picked.size && !(e.target as HTMLElement).closest(".card, .section-title")) setPicked(new Set());
          }}
        >
          {sections.map(([group, items]) => (
            <section key={group || "-"} className="conn-group">
              {(sections.length > 1 || group !== sel) && (
                <h3 className="section-title" onClick={() => setSel(group)}>
                  {group || t("Ungrouped")}
                </h3>
              )}
              <div className="card-grid">
                {items.map((c) => (
                  <div
                    key={c.id}
                    className={`card ${c.env === "production" ? "is-prod" : ""} ${picked.has(c.id) ? "picked" : ""} ${picked.size ? "picking" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      const ids = picked.has(c.id) ? pickedIds : [c.id];
                      e.dataTransfer.setData("application/x-dbdock-ids", JSON.stringify(ids));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || picked.size) togglePick(c.id);
                    }}
                    onDoubleClick={() => !picked.size && onConnect(c)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ id: c.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="card-color" style={{ background: c.color }} />
                    <button
                      className="pick"
                      role="checkbox"
                      aria-checked={picked.has(c.id)}
                      aria-label={`Select ${c.name}`}
                      title={picked.has(c.id) ? t("Deselect") : t("Select (⌘-click also works)")}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePick(c.id);
                      }}
                    >
                      <Check size={12} strokeWidth={3} />
                    </button>
                    <DbIcon kind={c.kind} size={36} />
                    <div className="card-text">
                      <div className="card-title">
                        <b title={c.name}>{c.name}</b>
                        <EnvBadge env={c.env} />
                      </div>
                      <div className="card-sub mono" title={target(c)}>
                        {target(c)}
                      </div>
                      {c.ssh.enabled && (
                        <div className="card-sub mono" title={`SSH ${c.ssh.user}@${c.ssh.host}`}>
                          <span className="ssh-tag">SSH</span>
                          {c.ssh.user ? `${c.ssh.user}@` : ""}
                          {c.ssh.host}
                        </div>
                      )}
                    </div>
                    <div className={`btn-group card-actions ${connecting === c.id ? "busy" : ""}`} role="group" onClick={(e) => e.stopPropagation()}>
                      <button title={t("Edit")} aria-label={t("Edit")} onClick={() => onEdit(c)}>
                        <Pencil size={13} />
                      </button>
                      <button title={t("More")} aria-label={t("More")} onClick={(e) => setMenu({ id: c.id, x: e.clientX, y: e.clientY })}>
                        <MoreHorizontal size={13} />
                      </button>
                      <button className="primary" disabled={connecting === c.id} onClick={() => onConnect(c)}>
                        <Plug size={13} />
                        {connecting === c.id ? t("Connecting…") : t("Connect")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!shown.length && (
            <div className="empty">
              {conns.length ? (
                <>
                   {t("No connections match.")}{" "}
                  {(query || envFilter !== null) && (
                    <button
                      className="link"
                      onClick={() => {
                        setQuery("");
                        setEnvFilter(null);
                      }}
                    >
                       {t("Clear filters")} </button>
                  )}
                </>
              ) : (
                t("No connections yet. Create one for MySQL, PostgreSQL, SQLite or Redis, optionally through SSH, or import them from TablePlus.")
              )}
            </div>
          )}
        </div>
      </section>

      {menu && (
        <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 220) }} onClick={(e) => e.stopPropagation()}>
          {"id" in menu
            ? (() => {
                const c = conns.find((x) => x.id === menu.id);
                if (!c) return null;
                const close = () => setMenu(null);
                return (
                  <>
                    <button onClick={() => (close(), onConnect(c))}><Plug size={14} />{t("Connect")}</button>
                    <button onClick={() => (close(), onEdit(c))}><Pencil size={14} />{t("Edit…")}</button>
                    <button onClick={() => (close(), setDialog({ kind: "move", ids: picked.has(c.id) ? pickedIds : [c.id] }))}><FolderInput size={14} />{t("Move to group…")}</button>
                    <button onClick={() => (close(), togglePick(c.id))}>
                      {picked.has(c.id) ? <SquareMinus size={14} /> : <SquareCheck size={14} />}
                      {picked.has(c.id) ? t("Deselect") : t("Select")}
                    </button>
                    <button onClick={() => (close(), setDialog({ kind: "export", ids: [c.id] }))}><FileUp size={14} />{t("Export…")}</button>
                    <hr />
                    <button className="danger" onClick={() => (close(), void deleteConnections(picked.has(c.id) ? pickedIds : [c.id]))}>
                      <Trash2 size={14} />{t("Delete")} </button>
                  </>
                );
              })()
            : (() => {
                const g = menu.group;
                const close = () => setMenu(null);
                return (
                  <>
                    <button onClick={() => (close(), onEdit({ newInGroup: g }))}><Plus size={14} />{t("New connection here…")}</button>
                    <button onClick={() => (close(), setDialog({ kind: "new-group", parent: g }))}><FolderPlus size={14} />{t("New subgroup…")}</button>
                    <button onClick={() => (close(), setDialog({ kind: "rename-group", path: g }))}><PenLine size={14} />{t("Rename / move…")}</button>
                    <button onClick={() => (close(), setPicked(new Set(conns.filter((c) => within(c.group, g)).map((c) => c.id))))}><ListChecks size={14} />{t("Select its connections")}</button>
                    <hr />
                    <button className="danger" onClick={() => (close(), setDialog({ kind: "delete-group", path: g }))}>
                      <Trash2 size={14} />{t("Delete group…")} </button>
                  </>
                );
              })()}
        </div>
      )}

      {dialog?.kind === "new-group" && (
        <PromptDialog
          title={t("New group")}
          label={t("Group path")}
          initial={dialog.parent ? dialog.parent + SEP : ""}
          placeholder="Work / Staging"
          hint={<>{t("Use “ / ” to nest, e.g. Acme / AI.")}</>}
          confirm={t("Create")}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const p = await api.createGroup(v);
            setDialog(null);
            await reload();
            setSel(p);
            toast("ok", tf("Created {name}", { name: p }));
          }}
        />
      )}
      {dialog?.kind === "rename-group" && (
        <PromptDialog
          title={t("Rename or move group")}
          label={t("New path")}
          initial={dialog.path}
          options={groups.filter((g) => !within(g, dialog.path))}
          hint={<>{t("Subgroups and")} {groupCount(dialog.path)}  {t("connection(s) move along. Put a parent in front to nest it, e.g. Work /")} {leaf(dialog.path)}.</>}
          confirm={t("Rename")}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const n = await api.renameGroup(dialog.path, v);
            setDialog(null);
            await reload();
            setSel(v.split("/").map((s) => s.trim()).filter(Boolean).join(SEP));
            toast("ok", tf("Renamed to {name} ({count} connections)", { name: v, count: n }));
          }}
        />
      )}
      {dialog?.kind === "delete-group" && (
        <PromptDialog
          title={tf("Delete group “{name}”", { name: leaf(dialog.path) })}
          label={tf("Move its {count} connection(s) to", { count: groupCount(dialog.path) })}
          initial={dialog.path.includes(SEP) ? dialog.path.slice(0, dialog.path.lastIndexOf(SEP)) : ""}
          placeholder={t("empty = Ungrouped")}
          options={groups.filter((g) => !within(g, dialog.path))}
          allowEmpty
          hint={t("Subgroups are removed too. Connections are kept and moved; nothing is deleted from the databases.")}
          confirm={t("Delete group")}
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const n = await api.deleteGroup(dialog.path, v);
            setDialog(null);
            await reload();
            setSel(v || null);
            toast("ok", tf("Deleted group; moved {count} connections to {group}", { count: n, group: v || t("Ungrouped") }));
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <PromptDialog
          title={tf("Move {count} connection(s)", { count: dialog.ids.length })}
          label={t("To group")}
          initial={dialog.ids.length === 1 ? (conns.find((c) => c.id === dialog.ids[0])?.group ?? "") : sel ?? ""}
          placeholder={t("empty = Ungrouped; a new name creates the group")}
          options={groups}
          allowEmpty
          confirm={t("Move")}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await api.moveConnections(dialog.ids, v);
            setDialog(null);
            setPicked(new Set());
            await reload();
            toast("ok", tf("Moved {count} to {group}", { count: dialog.ids.length, group: v || t("Ungrouped") }));
          }}
        />
      )}
      {dialog?.kind === "ssh-hosts" && <SshHostsDialog conns={conns} onClose={() => setDialog(null)} />}
      {dialog?.kind === "health" && <HealthDialog connections={dialog.connections} onClose={() => setDialog(null)} onEdit={onEdit} />}
      {dialog?.kind === "import" && <ImportDialog pasteFirst={dialog.paste} onClose={() => setDialog(null)} onDone={imported} />}
      {dialog?.kind === "export" && (
        <TransferDialog
          mode={{ kind: "export", ids: dialog.ids }}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            toast("ok", msg);
            void reload();
          }}
        />
      )}
    </div>
  );
}
