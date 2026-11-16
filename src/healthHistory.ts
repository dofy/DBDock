import type { ConnectionConfig } from './api';

export type HealthRecord = { status: 'ok' | 'error'; checkedAt: number; fingerprint: string };
type Snapshot = Readonly<Record<string, HealthRecord>>;
type CheckToken = { id: string; fingerprint: string; revision: number; epoch: number };
const KEY = 'dbdock.health-history.v1';
const listeners = new Set<() => void>();
const revisions = new Map<string, number>();
let epoch = 0;

/** Hash only connection settings, never passwords or diagnostic messages. */
export function connectionFingerprint(c: ConnectionConfig): string {
  const value = JSON.stringify([c.kind, c.host, c.port, c.user, c.database, c.file, c.redisDb, c.cfAccountId, c.options, c.ssh]);
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}

function load(): Snapshot {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
      const r = value as HealthRecord | null;
      return r && (r.status === 'ok' || r.status === 'error') && typeof r.checkedAt === 'number' && Number.isFinite(new Date(r.checkedAt).getTime()) && typeof r.fingerprint === 'string';
    }));
  } catch { return {}; }
}
let current: Snapshot = load();
function publish(next: Snapshot) {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* still available for this session */ }
  listeners.forEach((listener) => listener());
}
export const healthSnapshot = () => current;
export function subscribeHealth(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function beginHealthCheck(c: ConnectionConfig): CheckToken {
  return { id: c.id, fingerprint: connectionFingerprint(c), revision: revisions.get(c.id) ?? 0, epoch };
}
export function finishHealthCheck(token: CheckToken, status: HealthRecord['status'], checkedAt = Date.now()) {
  if (token.epoch !== epoch || token.revision !== (revisions.get(token.id) ?? 0)) return;
  publish({ ...current, [token.id]: { status, checkedAt, fingerprint: token.fingerprint } });
}
export function clearHealth(ids: readonly string[]) {
  const next = { ...current };
  for (const id of ids) { revisions.set(id, (revisions.get(id) ?? 0) + 1); delete next[id]; }
  publish(next);
}
export function clearAllHealth() { epoch++; publish({}); }
export function latestHealth(c: ConnectionConfig, snapshot: Snapshot): HealthRecord | undefined {
  const record = snapshot[c.id];
  return record?.fingerprint === connectionFingerprint(c) ? record : undefined;
}
