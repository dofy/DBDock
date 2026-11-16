import { t, tf } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errText, fmtTtl, type KeyInfo, type KeyValue, type SessionInfo } from "../api";
import { RefreshCw, Trash2 } from "lucide-react";

interface Props {
  session: SessionInfo;
}

interface ConsoleLine {
  cmd: string;
  out: string;
  error?: boolean;
}

function fmtReply(v: unknown, indent = ""): string {
  if (v === null) return `${indent}(nil)`;
  if (typeof v === "number") return `${indent}(integer) ${v}`;
  if (typeof v === "string") return `${indent}"${v}"`;
  if (typeof v === "boolean") return `${indent}(boolean) ${v}`;
  if (Array.isArray(v)) {
    if (!v.length) return `${indent}(empty array)`;
    return v
      .map((x, i) => {
        const nested = Array.isArray(x) ? `\n${fmtReply(x, indent + "   ")}` : ` ${fmtReply(x)}`;
        return `${indent}${i + 1})${nested}`;
      })
      .join("\n");
  }
  return `${indent}${JSON.stringify(v)}`;
}

function ValueView({ kv }: { kv: KeyValue }) {
  const v = kv.value as never;
  switch (kv.type) {
    case "string": {
      const s = kv.value as string;
      let pretty: string | null = null;
      try {
        const j = JSON.parse(s);
        if (typeof j === "object" && j !== null) pretty = JSON.stringify(j, null, 2);
      } catch {
        /* not JSON */
      }
      return <pre className="value">{pretty ?? s}</pre>;
    }
    case "hash":
      return <KV rows={v as [string, string][]} head={[t("field"), t("value")]} />;
    case "zset":
      return <KV rows={(v as [string, number][]).map(([m, s]) => [m, String(s)])} head={[t("member"), t("score")]} />;
    case "list":
    case "set":
      return <KV rows={(v as string[]).map((x, i) => [String(i), x])} head={[kv.type === "list" ? t("index") : "#", t("value")]} />;
    case "stream":
      return (
        <KV
          rows={(v as [string, string[]][]).map(([id, fields]) => [
            id,
            fields
              .reduce<string[]>((acc, x, i) => (i % 2 ? [...acc.slice(0, -1), `${acc[acc.length - 1]}=${x}`] : [...acc, x]), [])
              .join("  "),
          ])}
          head={[t("id"), t("fields")]}
        />
      );
    default:
      return <pre className="value">{JSON.stringify(kv.value, null, 2)}</pre>;
  }
}

function KV({ rows, head }: { rows: string[][]; head: string[] }) {
  return (
    <div className="grid-scroll">
      <table className="grid">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j === 0 ? "key-col" : ""}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RedisWorkspace({ session }: Props) {
  const sid = session.sessionId;
  const [db, setDb] = useState(Number(session.defaultSchema) || 0);
  const [dbsize, setDbsize] = useState<number | null>(null);
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
  const [selected, setSelected] = useState<KeyValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const consoleEnd = useRef<HTMLDivElement>(null);

  /** SCAN may return few keys per call; keep going until ~200 keys or the cursor ends. */
  const scan = useCallback(
    async (from: number, reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        let cur = from;
        const got: KeyInfo[] = [];
        do {
          const page = await api.redisScan(sid, cur, pattern, 500);
          got.push(...page.keys);
          cur = page.cursor;
        } while (cur !== 0 && got.length < 200);
        setKeys((k) => (reset ? got : [...k, ...got]).sort((a, b) => a.key.localeCompare(b.key)));
        setCursor(cur === 0 ? null : cur);
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [sid, pattern],
  );

  const refresh = useCallback(async () => {
    try {
      const info = await api.redisSelect(sid);
      setDb(info.db);
      setDbsize(info.dbsize);
    } catch (e) {
      setError(errText(e));
    }
    await scan(0, true);
  }, [sid, scan]);

  useEffect(() => {
    void refresh();
    // only on session start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  useEffect(() => {
    consoleEnd.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const switchDb = async (n: number) => {
    try {
      const info = await api.redisSelect(sid, n);
      setDb(info.db);
      setDbsize(info.dbsize);
      setSelected(null);
      await scan(0, true);
    } catch (e) {
      setError(errText(e));
    }
  };

  const open = async (key: string) => {
    try {
      setSelected(await api.redisGet(sid, key));
    } catch (e) {
      setError(errText(e));
    }
  };

  const del = async () => {
    if (!selected) return;
    if (!(await ask(tf('Delete key "{name}"? This cannot be undone.', { name: selected.key }), { title: t("Delete key"), kind: "warning" }))) return;
    try {
      await api.redisDelete(sid, selected.id);
      setKeys((k) => k.filter((x) => x.id !== selected.id));
      setSelected(null);
      setDbsize((n) => (n == null ? n : n - 1));
    } catch (e) {
      setError(errText(e));
    }
  };

  const runCmd = async () => {
    const line = cmd.trim();
    if (!line) return;
    setCmd("");
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    setHIdx(-1);
    try {
      const out = await api.redisCommand(sid, line);
      setLines((l) => [...l, { cmd: line, out: fmtReply(out) }]);
      if (/^select\s/i.test(line)) {
        const info = await api.redisSelect(sid);
        setDb(info.db);
        setDbsize(info.dbsize);
        await scan(0, true);
      } else if (selected) {
        void open(selected.id).catch(() => {});
      }
    } catch (e) {
      setLines((l) => [...l, { cmd: line, out: `(error) ${errText(e)}`, error: true }]);
    }
  };

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="row">
          <select value={db} onChange={(e) => void switchDb(Number(e.target.value))} title={t("Database")}>
            {Array.from({ length: Math.max(16, db + 1) }, (_, i) => (
              <option key={i} value={i}>
                db{i}
              </option>
            ))}
          </select>
          <span className="muted small">{dbsize != null ? tf("{count} keys", { count: dbsize }) : ""}</span>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void scan(0, true);
          }}
        >
          <input className="search" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t("pattern, e.g. user:*")} spellCheck={false} />
          <button type="submit" disabled={loading} title={t("Scan")}>
            <RefreshCw size={14} />
          </button>
        </form>
        {error && <div className="status bad">{error}</div>}
        <ul className="list">
          {keys.map((k) => (
            <li key={k.id} className={selected?.id === k.id ? "on" : ""} onClick={() => void open(k.id)} title={k.key}>
              <span className={`rtype t-${k.type}`}>{k.type === "string" ? "str" : k.type === "stream" ? "strm" : k.type}</span>
              <span className="kname">{k.key}</span>
            </li>
          ))}
          {cursor != null && (
            <li className="more" onClick={() => void scan(cursor, false)}>
              {loading ? t("Scanning…") : t("Load more…")}
            </li>
          )}
          {!keys.length && cursor == null && <li className="muted">{t("No keys")}</li>}
        </ul>
      </aside>

      <section className="main redis-main">
        <div className="key-pane">
          {selected ? (
            <>
              <div className="toolbar">
                <span className={`rtype t-${selected.type}`}>{selected.type}</span>
                <b className="kname">{selected.key}</b>
                <span className="muted">
                  TTL {fmtTtl(selected.ttl)} · {tf(selected.type === "string" ? "{count} bytes" : "{count} items", { count: selected.size })}
                  {selected.truncated && t(" · preview")}
                </span>
                <span className="spacer" />
                <button onClick={() => void open(selected.id)} title={t("Reload")}>
                  <RefreshCw size={14} />
                </button>
                <button className="danger" onClick={del}>
                  <Trash2 size={14} />{t("Delete")} </button>
              </div>
              <ValueView kv={selected} />
            </>
          ) : (
            <div className="grid-empty muted">{t("Select a key.")}</div>
          )}
        </div>
        <div className="console">
          <div className="console-out">
            {lines.map((l, i) => (
              <div key={i}>
                <div className="prompt">
                  db{db}&gt; {l.cmd}
                </div>
                <pre className={l.error ? "error" : ""}>{l.out}</pre>
              </div>
            ))}
            <div ref={consoleEnd} />
          </div>
          <input
            className="console-in"
            value={cmd}
            placeholder={t("Redis command, e.g. HGETALL user:1   (↑ history)")}
            spellCheck={false}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runCmd();
              else if (e.key === "ArrowUp" && history.length) {
                const i = Math.min(hIdx + 1, history.length - 1);
                setHIdx(i);
                setCmd(history[i]);
                e.preventDefault();
              } else if (e.key === "ArrowDown") {
                const i = hIdx - 1;
                setHIdx(Math.max(-1, i));
                setCmd(i >= 0 ? history[i] : "");
                e.preventDefault();
              }
            }}
          />
        </div>
      </section>
    </div>
  );
}
