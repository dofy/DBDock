/** Recent SQL stays in memory for this app run, grouped by connection and database. */
export class SqlHistory {
  private entries = new Map<string, string[]>();
  private key(connectionId: string, database: string) { return JSON.stringify([connectionId, database]); }
  get(connectionId: string, database: string): string[] { return this.entries.get(this.key(connectionId, database)) ?? []; }
  add(connectionId: string, database: string, sql: string): string[] {
    const text = sql.trim();
    if (!text) return this.get(connectionId, database);
    const key = this.key(connectionId, database);
    const next = [text, ...(this.entries.get(key) ?? []).filter((item) => item !== text)].slice(0, 30);
    this.entries.set(key, next);
    return next;
  }
}

/** Run a selection when present, otherwise the line containing the cursor. */
export function selectedOrCurrentLine(doc: string, from: number, to: number): string {
  if (from !== to) return doc.slice(from, to);
  const position = Math.max(0, Math.min(from, doc.length));
  const start = position === 0 ? -1 : doc.lastIndexOf('\n', position - 1);
  const end = doc.indexOf('\n', position);
  return doc.slice(start < 0 ? 0 : start + 1, end < 0 ? doc.length : end).replace(/\r$/, '');
}
