import { siCloudflare, siMongodb, siMysql, siPostgresql, siRedis, siSqlite } from "simple-icons";
import type { Kind } from "../api";

const ICONS: Record<Kind, { path: string; hex: string; title: string }> = {
  mysql: siMysql,
  postgres: siPostgresql,
  sqlite: siSqlite,
  redis: siRedis,
  d1: siCloudflare,
  mongodb: siMongodb,
};

/** Product logo (Simple Icons, CC0) on a theme-aware tile. */
export function DbIcon({ kind, size = 32 }: { kind: Kind; size?: number }) {
  const i = ICONS[kind];
  return (
    <span className="db-icon" data-kind={kind} style={{ width: size, height: size, color: `#${i.hex}` }} title={i.title}>
      <svg viewBox="0 0 24 24" width={size * 0.66} height={size * 0.66} aria-hidden="true">
        <path d={i.path} fill="currentColor" />
      </svg>
    </span>
  );
}
