/** Recent SQL stays in memory for this app run, grouped by connection and database. */
export class SqlHistory {
  private entries = new Map<string, string[]>();
  private key(connectionId: string, database: string) { return JSON.stringify([connectionId, database]); }
  get(connectionId: string, database: string): string[] { return this.entries.get(this.key(connectionId, database)) ?? []; }
  add(connectionId: string, database: string, sql: string): string[] {
    const text = sql.trim();
    if (!text) return this.get(connectionId, database);
    const key = this.key(connectionId, database);
    const next = [text, ...(this.entries.get(key) ?? []).filter((item) => item !== text)].slice(0, 100);
    this.entries.set(key, next);
    return next;
  }
}
