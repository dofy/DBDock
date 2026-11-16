import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, ENV_LABEL, ENVS, errText, type ConnectionConfig } from "../api";
import { DbIcon } from "./DbIcon";
import { PromptDialog } from "./Dialogs";
import { useToast } from "./Toast";
import { TransferDialog } from "./TransferDialog";
import { ImportDialog, type ImportReport } from "./ImportDialog";
import { SshHostsDialog } from "./SshHostsDialog";
import { Check, FileUp, FolderInput, FolderPlus, ListChecks, MoreHorizontal, PenLine, Pencil, Plug, Plus, SquareCheck, SquareMinus, Trash2, X } from "lucide-react";

const SEP = " / ";
/** null = all connections, "" = ungrouped, otherwise a group path (includes subgroups). */
type GroupSel = string | null;

const within = (g: string, root: string) => g === root || g.startsWith(root + SEP);
const leaf = (g: string) => g.split(SEP).pop() ?? g;
const depth = (g: string) => g.split(SEP).length - 1;

export function EnvBadge({ env }: { env: string }) {
  if (!env) return null;
  return <span className={`env-badge env-${env}`}>{ENV_LABEL[env] ?? env.toUpperCase()}</span>;
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
  | { kind: "ssh-hosts" };

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
    const msg = ids.length === 1 ? `Delete connection "${names[0]}" and its saved passwords?` : `Delete ${ids.length} connections and their saved passwords?\n\n${names.join(", ")}`;
    if (!(await ask(msg, { title: "Delete", kind: "warning" }))) return;
    await run(() => api.deleteConnections(ids), ids.length === 1 ? `Deleted ${names[0]}` : `Deleted ${ids.length} connections`);
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
      if (ids.length) void run(() => api.moveConnections(ids, group), `Moved ${ids.length} to ${group || "Ungrouped"}`).then(() => setPicked(new Set()));
    },
  });

  const imported = (r: ImportReport) => {
    setDialog(null);
    const parts = [`${r.added} new`, `${r.updated} updated`];
    if (r.withSecrets) parts.push(`${r.withSecrets} with passwords`);
    let msg = `Imported from ${r.source.split(" · ")[0]}: ${parts.join(", ")}`;
    if (r.skipped.length) msg += `. Skipped: ${r.skipped.join(", ")}`;
    if (r.passwordsNotImported) msg += ". Passwords are not readable from that app; enter each once.";
    toast(r.skipped.length ? "info" : "ok", msg);
    void reload();
  };

  const title = sel === null ? "All connections" : sel === "" ? "Ungrouped" : sel;
  const pickedIds = [...picked];

  return (
    <div className="home-view">
      <aside className="home-side">
        <div className="search-box">
          <input ref={searchRef} className="search" placeholder="Search  ⌘F" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {query && (
            <button className="clear" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
        <ul className="tree">
          <li className={`tree-row ${sel === null ? "on" : ""}`} onClick={() => setSel(null)}>
            <span className="tree-icon">◎</span>
            <span className="tree-name">All connections</span>
            <span className="count">{conns.length}</span>
          </li>
          <li className="tree-head">
            <span>Groups</span>
            <button className="icon-btn" title="New group" onClick={() => setDialog({ kind: "new-group", parent: sel && sel !== "" ? sel : "" })}>
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
              <span className="tree-icon">▤</span>
              <span className="tree-name" title={g}>
                {leaf(g)}
              </span>
              <span className="count">{groupCount(g)}</span>
              <button
                className="icon-btn more"
                title="Group actions"
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
            <span className="tree-icon">▢</span>
            <span className="tree-name muted">Ungrouped</span>
            <span className="count">{ungrouped}</span>
          </li>
        </ul>
        <p className="hint side-hint">Drag connections onto a group to move them. Right-click a group for more.</p>
      </aside>

      <section className="home-main">
        <div className="home-head">
          <h1 title={title}>{title}</h1>
          <span className="muted">{shown.length}</span>
          <span className="spacer" />
          <button className="primary" onClick={() => onEdit({ newInGroup: sel ?? "" })}>
            <Plus size={14} />New connection
          </button>
        </div>
        <div className="env-filter">
          <button className={`chip ${envFilter === null ? "on" : ""}`} onClick={() => setEnvFilter(null)}>
            All {inGroup.length}
          </button>
          {[...ENVS, ""]
            .filter((e) => envCounts.has(e))
            .map((e) => (
              <button key={e || "none"} className={`chip env-chip env-${e || "none"} ${envFilter === e ? "on" : ""}`} onClick={() => setEnvFilter(envFilter === e ? null : e)}>
                {e ? ENV_LABEL[e] : "untagged"} {envCounts.get(e)}
              </button>
            ))}
        </div>

        {picked.size > 0 && (
          <div className="bulk-bar">
            <b>{picked.size} selected</b>
            <button className="link" onClick={() => setPicked(new Set(shown.map((c) => c.id)))}>
              Select all {shown.length}
            </button>
            <span className="spacer" />
            <button onClick={() => setDialog({ kind: "move", ids: pickedIds })}><FolderInput size={14} />Move to group…</button>
            <button onClick={() => setDialog({ kind: "export", ids: pickedIds })}><FileUp size={14} />Export…</button>
            <button className="danger" onClick={() => void deleteConnections(pickedIds)}>
              <Trash2 size={14} />Delete
            </button>
            <button onClick={() => setPicked(new Set())}><Check size={14} />Done</button>
          </div>
        )}

        <div className="home-scroll">
          {sections.map(([group, items]) => (
            <section key={group || "-"} className="conn-group">
              {(sections.length > 1 || group !== sel) && (
                <h3 className="section-title" onClick={() => setSel(group)}>
                  {group || "Ungrouped"}
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
                    <input
                      type="checkbox"
                      className="pick"
                      checked={picked.has(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => togglePick(c.id)}
                      aria-label={`Select ${c.name}`}
                    />
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
                    <div className={`card-actions ${connecting === c.id ? "busy" : ""}`} onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Edit" onClick={() => onEdit(c)}>
                        <Pencil size={14} />
                      </button>
                      <button className="icon-btn" title="More" onClick={(e) => setMenu({ id: c.id, x: e.clientX, y: e.clientY })}>
                        <MoreHorizontal size={14} />
                      </button>
                      <button className="primary small-btn" disabled={connecting === c.id} onClick={() => onConnect(c)}>
                        <Plug size={13} />
                        {connecting === c.id ? "…" : "Connect"}
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
                  No connections match.{" "}
                  {(query || envFilter !== null) && (
                    <button
                      className="link"
                      onClick={() => {
                        setQuery("");
                        setEnvFilter(null);
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </>
              ) : (
                "No connections yet. Create one for MySQL, PostgreSQL, SQLite or Redis, optionally through SSH, or import them from TablePlus."
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
                    <button onClick={() => (close(), onConnect(c))}><Plug size={14} />Connect</button>
                    <button onClick={() => (close(), onEdit(c))}><Pencil size={14} />Edit…</button>
                    <button onClick={() => (close(), setDialog({ kind: "move", ids: picked.has(c.id) ? pickedIds : [c.id] }))}><FolderInput size={14} />Move to group…</button>
                    <button onClick={() => (close(), togglePick(c.id))}>
                      {picked.has(c.id) ? <SquareMinus size={14} /> : <SquareCheck size={14} />}
                      {picked.has(c.id) ? "Deselect" : "Select"}
                    </button>
                    <button onClick={() => (close(), setDialog({ kind: "export", ids: [c.id] }))}><FileUp size={14} />Export…</button>
                    <hr />
                    <button className="danger" onClick={() => (close(), void deleteConnections(picked.has(c.id) ? pickedIds : [c.id]))}>
                      <Trash2 size={14} />Delete
                    </button>
                  </>
                );
              })()
            : (() => {
                const g = menu.group;
                const close = () => setMenu(null);
                return (
                  <>
                    <button onClick={() => (close(), onEdit({ newInGroup: g }))}><Plus size={14} />New connection here…</button>
                    <button onClick={() => (close(), setDialog({ kind: "new-group", parent: g }))}><FolderPlus size={14} />New subgroup…</button>
                    <button onClick={() => (close(), setDialog({ kind: "rename-group", path: g }))}><PenLine size={14} />Rename / move…</button>
                    <button onClick={() => (close(), setPicked(new Set(conns.filter((c) => within(c.group, g)).map((c) => c.id))))}><ListChecks size={14} />Select its connections</button>
                    <hr />
                    <button className="danger" onClick={() => (close(), setDialog({ kind: "delete-group", path: g }))}>
                      <Trash2 size={14} />Delete group…
                    </button>
                  </>
                );
              })()}
        </div>
      )}

      {dialog?.kind === "new-group" && (
        <PromptDialog
          title="New group"
          label="Group path"
          initial={dialog.parent ? dialog.parent + SEP : ""}
          placeholder="Work / Staging"
          hint={<>Use “ / ” to nest, e.g. Acme / AI.</>}
          confirm="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const p = await api.createGroup(v);
            setDialog(null);
            await reload();
            setSel(p);
            toast("ok", `Created ${p}`);
          }}
        />
      )}
      {dialog?.kind === "rename-group" && (
        <PromptDialog
          title="Rename or move group"
          label="New path"
          initial={dialog.path}
          options={groups.filter((g) => !within(g, dialog.path))}
          hint={<>Subgroups and {groupCount(dialog.path)} connection(s) move along. Put a parent in front to nest it, e.g. Work / {leaf(dialog.path)}.</>}
          confirm="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const n = await api.renameGroup(dialog.path, v);
            setDialog(null);
            await reload();
            setSel(v.split("/").map((s) => s.trim()).filter(Boolean).join(SEP));
            toast("ok", `Renamed to ${v} (${n} connection(s))`);
          }}
        />
      )}
      {dialog?.kind === "delete-group" && (
        <PromptDialog
          title={`Delete group “${leaf(dialog.path)}”`}
          label={`Move its ${groupCount(dialog.path)} connection(s) to`}
          initial={dialog.path.includes(SEP) ? dialog.path.slice(0, dialog.path.lastIndexOf(SEP)) : ""}
          placeholder="empty = Ungrouped"
          options={groups.filter((g) => !within(g, dialog.path))}
          allowEmpty
          hint="Subgroups are removed too. Connections are kept and moved; nothing is deleted from the databases."
          confirm="Delete group"
          danger
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const n = await api.deleteGroup(dialog.path, v);
            setDialog(null);
            await reload();
            setSel(v || null);
            toast("ok", `Deleted group; moved ${n} connection(s) to ${v || "Ungrouped"}`);
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <PromptDialog
          title={`Move ${dialog.ids.length} connection(s)`}
          label="To group"
          initial={dialog.ids.length === 1 ? (conns.find((c) => c.id === dialog.ids[0])?.group ?? "") : sel ?? ""}
          placeholder="empty = Ungrouped; a new name creates the group"
          options={groups}
          allowEmpty
          confirm="Move"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await api.moveConnections(dialog.ids, v);
            setDialog(null);
            setPicked(new Set());
            await reload();
            toast("ok", `Moved ${dialog.ids.length} to ${v || "Ungrouped"}`);
          }}
        />
      )}
      {dialog?.kind === "ssh-hosts" && <SshHostsDialog conns={conns} onClose={() => setDialog(null)} />}
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
