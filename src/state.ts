import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Decision } from './types.js';

// node:sqlite is built in (no native build step). Loaded via require so bundlers/test runners
// that do not know the module yet do not choke on it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export const CACHE_STREAK = 3;
export const CACHE_MIN_CONFIDENCE = 0.9;

export interface DecisionRow {
  message_id: string;
  category: string;
  confidence: number;
  source: string;
  reason: string;
  applied: number;
  created_at: string;
}

/** SQLite state. Every table carries user_id from day one so multi-user is not a rewrite. */
export class State {
  private readonly db: DatabaseSyncType;

  constructor(
    path: string,
    private readonly userId = 'default',
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
      CREATE TABLE IF NOT EXISTS decisions (
        user_id TEXT, message_id TEXT, category TEXT, confidence REAL, source TEXT,
        reason TEXT, applied INTEGER, created_at TEXT,
        PRIMARY KEY (user_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS sender_cache (
        user_id TEXT, sender TEXT, category TEXT, streak INTEGER,
        PRIMARY KEY (user_id, sender)
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        user_id TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_id, day)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getCursor(): string | null {
    const row = this.db
      .prepare('SELECT value FROM kv WHERE user_id = ? AND key = ?')
      .get(this.userId, 'historyId') as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCursor(value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO kv (user_id, key, value) VALUES (?, ?, ?)')
      .run(this.userId, 'historyId', value);
  }

  hasDecision(messageId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM decisions WHERE user_id = ? AND message_id = ?')
      .get(this.userId, messageId);
  }

  /** Idempotent on (user_id, message_id): a retried message is never double-recorded. */
  recordDecision(messageId: string, d: Decision, applied: boolean, now: Date): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO decisions
         (user_id, message_id, category, confidence, source, reason, applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.userId,
        messageId,
        d.category,
        d.confidence,
        d.source,
        d.reason,
        applied ? 1 : 0,
        now.toISOString(),
      );
  }

  appliedSince(iso: string): DecisionRow[] {
    return this.db
      .prepare(
        `SELECT message_id, category, confidence, source, reason, applied, created_at
         FROM decisions WHERE user_id = ? AND applied = 1 AND created_at >= ?`,
      )
      .all(this.userId, iso) as unknown as DecisionRow[];
  }

  cachedCategory(sender: string): string | null {
    const row = this.db
      .prepare('SELECT category, streak FROM sender_cache WHERE user_id = ? AND sender = ?')
      .get(this.userId, sender) as { category: string; streak: number } | undefined;
    return row && row.streak >= CACHE_STREAK ? row.category : null;
  }

  /** Same category with high confidence N times in a row earns a cache entry. */
  observeSender(sender: string, category: string, confidence: number): void {
    if (confidence < CACHE_MIN_CONFIDENCE) {
      this.db
        .prepare('DELETE FROM sender_cache WHERE user_id = ? AND sender = ?')
        .run(this.userId, sender);
      return;
    }
    const row = this.db
      .prepare('SELECT category, streak FROM sender_cache WHERE user_id = ? AND sender = ?')
      .get(this.userId, sender) as { category: string; streak: number } | undefined;
    const streak = row && row.category === category ? row.streak + 1 : 1;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sender_cache (user_id, sender, category, streak) VALUES (?, ?, ?, ?)',
      )
      .run(this.userId, sender, category, streak);
  }

  llmCallsToday(now: Date): number {
    const row = this.db
      .prepare('SELECT count FROM llm_calls WHERE user_id = ? AND day = ?')
      .get(this.userId, now.toISOString().slice(0, 10)) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countLlmCall(now: Date): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (user_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
      )
      .run(this.userId, now.toISOString().slice(0, 10));
  }
}
