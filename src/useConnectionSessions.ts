import { useRef, useState } from "react";
import { api, errText, type ConnectionConfig, type SessionInfo } from "./api";
import { useFeedbackDialog } from "./components/FeedbackDialog";
import { useToast } from "./components/Toast";
import { t, tf } from "./i18n";
import { destinationKey, sessionDatabase, type NavigationTarget } from "./navigation";

interface OpenSession {
  conn: ConnectionConfig;
  session: SessionInfo;
  database: string;
  destination: string;
  alternate: boolean;
}

interface PendingConnection {
  key: string;
  conn: ConnectionConfig;
  database?: string;
}

type ObjectTarget = Extract<NavigationTarget, { type: "schema" | "table" }>;

const pendingTabPrefix = "connecting:";

export function pendingConnectionTabId(key: string): string {
  return `${pendingTabPrefix}${key}`;
}

export function useConnectionSessions() {
  const toast = useToast();
  const { ask, message } = useFeedbackDialog();
  const [opened, setOpened] = useState<OpenSession[]>([]);
  const [active, setActive] = useState<string | null>(null); // Session or pending tab ID, null = home.
  const [connecting, setConnecting] = useState<PendingConnection[]>([]);
  const connectingIds = useRef(new Map<string, { attemptId: string; target?: ObjectTarget }>());
  const [navigationRequest, setNavigationRequest] = useState<{ sessionId: string; target: ObjectTarget }>();
  const dirtyTabs = useRef(new Map<string, Map<string, "dirty" | "busy">>());
  const closingSessions = useRef(new Set<string>());

  const cancelPending = (key: string) => {
    const attempt = connectingIds.current.get(key);
    if (!attempt) return;
    connectingIds.current.delete(key);
    setConnecting((pending) => pending.filter((item) => item.key !== key));
    setActive((current) => current === pendingConnectionTabId(key) ? null : current);
    void api.cancelConnect(attempt.attemptId).catch(() => {});
  };

  const connect = async (conn: ConnectionConfig, target?: NavigationTarget) => {
    const database = target && "database" in target && ["mysql", "postgres"].includes(conn.kind) ? target.database : undefined;
    const wanted = sessionDatabase(conn.kind, database ?? conn.database, "");
    const key = destinationKey(conn.id, wanted);
    const objectTarget = target?.type === "table" || target?.type === "schema" ? target : undefined;
    const existing = opened.find((item) => item.conn.id === conn.id && (item.destination === key || item.database === wanted));
    if (existing) {
      setActive(existing.session.sessionId);
      if (objectTarget) setNavigationRequest({ sessionId: existing.session.sessionId, target: objectTarget });
      return;
    }
    const pendingId = pendingConnectionTabId(key);
    const pending = connectingIds.current.get(key);
    if (pending) {
      pending.target = objectTarget;
      setActive(pendingId);
      return;
    }
    const attemptId = crypto.randomUUID();
    const attempt = { attemptId, target: objectTarget };
    connectingIds.current.set(key, attempt);
    setConnecting((items) => [...items, { key, conn, database }]);
    setActive(pendingId);
    const stillPending = () => connectingIds.current.get(key) === attempt;
    try {
      await api.beginConnect(attemptId);
      // Cancellation may have happened before the backend registered the attempt.
      if (!stillPending()) await api.cancelConnect(attemptId);
      const session = await api.connect(conn.id, attemptId, database || undefined);
      if (!stillPending()) { await api.disconnect(session.sessionId); return; }
      const actual = sessionDatabase(conn.kind, database ?? conn.database, session.defaultSchema);
      const alternate = !!database && database !== sessionDatabase(conn.kind, conn.database, "");
      setOpened((items) => [...items, { conn, session, database: actual, destination: key, alternate }]);
      if (attempt.target) setNavigationRequest({ sessionId: session.sessionId, target: attempt.target });
      setActive((current) => current === pendingId ? session.sessionId : current);
    } catch (e) {
      if (stillPending()) {
        const name = database ? `${conn.name} / ${database}` : conn.name;
        toast("error", `${name}: ${errText(e)}`);
        setActive((current) => current === pendingId ? null : current);
      }
    } finally {
      if (stillPending()) {
        connectingIds.current.delete(key);
        setConnecting((items) => items.filter((item) => item.key !== key));
      }
    }
  };

  const close = async (sessionId: string, confirmClose = false) => {
    if (closingSessions.current.has(sessionId)) return;
    closingSessions.current.add(sessionId);
    try {
      const tabs = dirtyTabs.current.get(sessionId);
      if (tabs && [...tabs.values()].includes("busy")) { await message(t("Wait for the commit to finish before closing this connection."), { kind: "warning" }); return; }
      if (confirmClose) {
        const item = opened.find((entry) => entry.session.sessionId === sessionId);
        const name = item?.alternate ? `${item.conn.name} / ${item.database}` : item?.conn.name ?? "";
        const question = tabs?.size
          ? tf('Close connection "{name}" and discard its uncommitted changes?', { name })
          : tf('Close connection "{name}"?', { name });
        if (!(await ask(question, { title: t("Close connection"), kind: tabs?.size ? "warning" : "question", okLabel: t("Close connection") }))) return;
      } else if (tabs?.size && !(await ask(t("Discard uncommitted changes in this connection?"), { title: t("Discard changes"), kind: "warning", okLabel: t("Discard") }))) return;
      dirtyTabs.current.delete(sessionId);
      void api.disconnect(sessionId);
      setOpened((o) => o.filter((x) => x.session.sessionId !== sessionId));
      setActive((current) => current === sessionId ? null : current);
    } finally {
      closingSessions.current.delete(sessionId);
    }
  };

  const closeActive = () => {
    if (!active) return;
    if (active.startsWith(pendingTabPrefix)) cancelPending(active.slice(pendingTabPrefix.length));
    else void close(active, true);
  };

  return {
    opened, active, setActive, connecting, navigationRequest, dirtyTabs,
    connect, cancelPending, close, closeActive,
  };
}
