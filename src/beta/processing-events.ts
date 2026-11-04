import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AccessDeniedError } from './access.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export type ProcessingEvent =
  | 'cycle_started'
  | 'checking_labels'
  | 'listing_inbox'
  | 'processing_messages'
  | 'cycle_completed'
  | 'cycle_stopped'
  | 'cycle_failed';

/** A bounded, per-user event trail containing no message contents or provider errors. */
export class BetaProcessingEvents {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('shared database file required');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS beta_processing_events (
      id INTEGER PRIMARY KEY, subject TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      event TEXT NOT NULL, status INTEGER, seen INTEGER, processed INTEGER, failed INTEGER
    ); CREATE INDEX IF NOT EXISTS beta_processing_events_subject_id
      ON beta_processing_events(subject, id DESC)`);
  }

  close(): void {
    this.db.close();
  }

  append(
    subject: string,
    now: number,
    event: ProcessingEvent,
    details: { status?: number; seen?: number; processed?: number; failed?: number } = {},
  ): void {
    if (!subject || subject.length > 255 || !Number.isSafeInteger(now) || now < 0)
      throw new Error('invalid processing event');
    const allowed: ProcessingEvent[] = [
      'cycle_started',
      'checking_labels',
      'listing_inbox',
      'processing_messages',
      'cycle_completed',
      'cycle_stopped',
      'cycle_failed',
    ];
    if (!allowed.includes(event)) throw new Error('invalid processing event');
    const count = (value: number | undefined) =>
      Number.isSafeInteger(value) && value! >= 0 ? value! : null;
    const status = details.status;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO beta_processing_events
          (subject, occurred_at, event, status, seen, processed, failed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subject,
          now,
          event,
          Number.isInteger(status) && status! >= 400 && status! <= 599 ? status! : null,
          count(details.seen),
          count(details.processed),
          count(details.failed),
        );
      this.db
        .prepare(
          `DELETE FROM beta_processing_events WHERE subject = ? AND id NOT IN
          (SELECT id FROM beta_processing_events WHERE subject = ? ORDER BY id DESC LIMIT 200)`,
        )
        .run(subject, subject);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recent(subject: string, now: number) {
    this.db.exec('BEGIN');
    try {
      const active = this.db
        .prepare(
          `SELECT 1 FROM beta_access_requests
          WHERE subject = ? AND status = 'approved' AND expires_at > ?`,
        )
        .get(subject, now);
      if (!active) throw new AccessDeniedError('access not active');
      const rows = this.db
        .prepare(
          `SELECT occurred_at, event, status, seen, processed, failed
          FROM beta_processing_events WHERE subject = ? ORDER BY id DESC LIMIT 100`,
        )
        .all(subject);
      this.db.exec('COMMIT');
      return rows;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Extract only an HTTP status; provider errors can contain credentials and mail data. */
export function safeHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.response?.status, candidate.status, candidate.code]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599)
      return value;
  }
  return undefined;
}
