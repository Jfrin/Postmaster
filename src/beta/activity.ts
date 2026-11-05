import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { State, type DecisionRow } from '../state.js';
import { AccessDeniedError } from './access.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Read only the verified owner's decisions; admin metrics do not reveal mailbox contents. */
export class BetaActivityStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('shared database file required');
    mkdirSync(dirname(path), { recursive: true });
    const schema = new State(path, '__beta_schema__');
    schema.close();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  close(): void {
    this.db.close();
  }

  recent(subject: string, now: number, limit = 100): DecisionRow[] {
    if (
      !subject ||
      subject.length > 255 ||
      subject.trim() !== subject ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('invalid activity request');
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
          `SELECT d.message_id, d.category, d.confidence, d.source, d.reason, d.applied, d.created_at,
          c.sender, c.subject FROM decisions AS d LEFT JOIN beta_email_content AS c
          ON c.user_id=d.user_id AND c.message_id=d.message_id AND c.expires_at > ?
        WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT ?`,
        )
        .all(now, subject, limit) as unknown as DecisionRow[];
      this.db.exec('COMMIT');
      return rows;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
