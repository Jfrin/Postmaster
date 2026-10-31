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
  sender?: string | null;
  subject?: string | null;
}

export interface DecisionMeta {
  sender?: string;
  subject?: string;
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
    // The UI container reads this file while the poller writes it; wait instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
      CREATE TABLE IF NOT EXISTS decisions (
        user_id TEXT, message_id TEXT, category TEXT, confidence REAL, source TEXT,
        reason TEXT, applied INTEGER, created_at TEXT, sender TEXT, subject TEXT,
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
    this.migrate();
  }

  /** Older databases lack the sender and subject columns the UI shows. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes('sender')) {
      this.db.exec('ALTER TABLE decisions ADD COLUMN sender TEXT');
      this.db.exec('ALTER TABLE decisions ADD COLUMN subject TEXT');
    }
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

  /** With appliedOnly, a dry-run decision does not count, so going live still files the message. */
  hasDecision(messageId: string, appliedOnly = false): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM decisions WHERE user_id = ? AND message_id = ?${appliedOnly ? ' AND applied = 1' : ''}`,
      )
      .get(this.userId, messageId);
  }

  /** Preserve applied decisions, but replace a dry-run decision when it is applied live. */
  recordDecision(
    messageId: string,
    d: Decision,
    applied: boolean,
    now: Date,
    meta: DecisionMeta = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO decisions
         (user_id, message_id, category, confidence, source, reason, applied, created_at, sender, subject)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, message_id) DO UPDATE SET
           category = excluded.category, confidence = excluded.confidence, source = excluded.source,
           reason = excluded.reason, applied = excluded.applied, created_at = excluded.created_at,
           sender = excluded.sender, subject = excluded.subject
         WHERE decisions.applied = 0 AND excluded.applied = 1`,
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
        meta.sender ?? null,
        meta.subject ?? null,
      );
  }

  recent(limit: number): DecisionRow[] {
    return this.db
      .prepare(
        `SELECT message_id, category, confidence, source, reason, applied, created_at, sender, subject
         FROM decisions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(this.userId, limit) as unknown as DecisionRow[];
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
