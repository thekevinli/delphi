import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Table = "plans" | "chat_receipts" | "grants" | "preferences" | "chat_local_replies";
/** Keep the existing filename and tables; retired experiment records stay untouched. */
export class PlanStore {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "research.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS plans_receipt ON plans(json_extract(body,'$.context.chatReceiptId'));
      CREATE INDEX IF NOT EXISTS receipt_scope_updated ON chat_receipts(json_extract(body,'$.scopeKey'),json_extract(body,'$.planning'),json_extract(body,'$.updatedAt'));
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_local_replies (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_local_replies_scope ON chat_local_replies(json_extract(body,'$.scopeKey'));
      CREATE TABLE IF NOT EXISTS chat_receipt_markers (marker TEXT PRIMARY KEY, receipt_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_receipt_markers_receipt ON chat_receipt_markers(receipt_id);`);
    // Derived lookup: migrate older receipts once rather than scan every chat
    // message against the entire receipt history on each load.
    for (const row of this.db.prepare("SELECT r.id,r.body FROM chat_receipts r WHERE NOT EXISTS (SELECT 1 FROM chat_receipt_markers m WHERE m.receipt_id=r.id)").all()) this.indexReceipt(String(row.id), JSON.parse(String(row.body)));
  }
  private indexReceipt(id: string, body: Record<string, unknown>) {
    for (const prompt of [body.forwardedPrompt, ...(Array.isArray(body.previousPrompts) ? body.previousPrompts : [])]) {
      const marker = String(prompt).match(/```delphi-plan-([a-f0-9]+)\n/)?.[1];
      if (marker) this.db.prepare("INSERT OR REPLACE INTO chat_receipt_markers VALUES(?,?)").run(marker, id);
    }
  }
  receiptForMarker(marker: string) {
    const row = this.db.prepare("SELECT r.body FROM chat_receipt_markers m JOIN chat_receipts r ON r.id=m.receipt_id WHERE m.marker=?").get(marker);
    return row ? JSON.parse(String(row.body)) as Record<string, unknown> : undefined;
  }
  planForReceipt(id: string): Record<string, unknown> | undefined {
    const row=this.db.prepare("SELECT body FROM plans WHERE json_extract(body,'$.context.chatReceiptId')=? LIMIT 1").get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  latestPlanningReceipt(scope: string): Record<string, unknown> | undefined {
    const row=this.db.prepare("SELECT body FROM chat_receipts WHERE json_extract(body,'$.scopeKey')=? AND json_extract(body,'$.planning')=1 ORDER BY json_extract(body,'$.updatedAt') DESC,rowid DESC LIMIT 1").get(scope);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  hasChatReceipts(scope: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_receipts WHERE json_extract(body,'$.scopeKey')=? LIMIT 1").get(scope);
  }
  localReplies(scopeKey: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT body FROM chat_local_replies WHERE json_extract(body,'$.scopeKey')=? ORDER BY rowid").all(scopeKey).map(row=>JSON.parse(String(row.body)));
  }
  clearLocalReplies(scopeKey: string) {
    this.db.prepare("DELETE FROM chat_local_replies WHERE json_extract(body,'$.scopeKey')=?").run(scopeKey);
  }
  objects(table: Table): Record<string, unknown>[] {
    return this.db.prepare(`SELECT body FROM ${table}`).all().map(row => JSON.parse(String(row.body)));
  }
  get(table: Table, id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  put(table: Table, id: string, body: unknown) {
    this.db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id, JSON.stringify(body));
    if (table === "chat_receipts") this.indexReceipt(id, body as Record<string, unknown>);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}
