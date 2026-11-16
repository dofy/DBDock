import type { ConnectionConfig } from "./api";

/** Only flag settings that cannot be used; blank host/port use app defaults. */
export function configurationIssues(c: ConnectionConfig): string[] {
  const issues: string[] = [];
  if (c.kind === "sqlite" && !c.file.trim()) issues.push("SQLite file is required");
  if (c.kind === "d1") {
    if (!c.cfAccountId.trim()) issues.push("Cloudflare account ID is required");
    if (!c.database.trim()) issues.push("Cloudflare database ID is required");
  }
  if (c.kind === "redis" && (!Number.isInteger(c.redisDb) || c.redisDb < 0)) issues.push("Redis database index must be a non-negative integer");
  const network = c.kind !== "sqlite" && c.kind !== "d1";
  const mongoUri = c.kind === "mongodb" && /^mongodb(?:\+srv)?:\/\//i.test(c.host.trim());
  if (network && !mongoUri && (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535)) issues.push("Database port must be between 1 and 65535, or empty for default");
  if (network && c.ssh.enabled) {
    if (!c.ssh.host.trim()) issues.push("SSH host is required");
    if (!Number.isInteger(c.ssh.port) || c.ssh.port < 0 || c.ssh.port > 65535) issues.push("SSH port must be between 1 and 65535, or empty for default");
    if (mongoUri) issues.push("With SSH, enter the MongoDB host and port separately");
  }
  return issues;
}
