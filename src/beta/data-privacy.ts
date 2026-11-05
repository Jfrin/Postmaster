import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { State, type PrivateStateIdentifiers } from '../state.js';
import { invalidateConsent } from './consent-fence.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
const DAY = 86_400_000;

/** The secret is never stored in SQLite. Identifiers are distinct per user and purpose. */
export function privateStateIdentifiers(key: Uint8Array, subject: string): PrivateStateIdentifiers {
  if (key.byteLength !== 32 || !subject) throw new Error('invalid private state identity');
  const hash = (purpose: string, value: string) =>
    `h1:${createHmac('sha256', key)
      .update(JSON.stringify(['beta-state-v1', subject, purpose, value]))
      .digest('hex')}`;
  return { message: (value) => hash('message', value), sender: (value) => hash('sender', value) };
}

export type DeletionScope = 'content' | 'decisions' | 'other' | 'all' | 'account';

/** All methods operate on one shared beta database, not the local single-user app. */
export class BetaDataPrivacy {
  private readonly db: DatabaseSyncType;

  constructor(path: string, key: Uint8Array, now: number) {
    if (!path || path === ':memory:' || key.byteLength !== 32)
      throw new Error('invalid privacy store');
    const schema = new State(path, '__beta_schema__');
    schema.close();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS beta_privacy_version (id INTEGER PRIMARY KEY CHECK(id=1), key_check BLOB NOT NULL)',
      );
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS beta_deleted_quota (subject TEXT PRIMARY KEY, day TEXT NOT NULL)',
      );
      const check = createHmac('sha256', key)
        .update('postmaster-beta-private-state-key-v1')
        .digest();
      const existing = this.db
        .prepare('SELECT key_check FROM beta_privacy_version WHERE id=1')
        .get() as { key_check: Uint8Array } | undefined;
      if (existing) {
        if (
          existing.key_check.byteLength !== check.length ||
          !timingSafeEqual(existing.key_check, check)
        )
          throw new Error('private state key changed');
      } else {
        const decisions = this.db
          .prepare('SELECT user_id,message_id,sender,subject,created_at FROM decisions')
          .all() as unknown as {
          user_id: string;
          message_id: string;
          sender: string | null;
          subject: string | null;
          created_at: string;
        }[];
        const update = this.db.prepare(
          "UPDATE decisions SET message_id=?, sender=NULL, subject=NULL, reason='' WHERE user_id=? AND message_id=?",
        );
        const content = this.db.prepare(
          'INSERT OR REPLACE INTO beta_email_content (user_id,message_id,sender,subject,expires_at) VALUES (?,?,?,?,?)',
        );
        for (const row of decisions) {
          const id = privateStateIdentifiers(key, row.user_id).message(row.message_id);
          const expiry = Date.parse(row.created_at) + DAY;
          if ((row.sender || row.subject) && Number.isSafeInteger(expiry) && expiry > now)
            content.run(row.user_id, id, row.sender, row.subject, expiry);
          update.run(id, row.user_id, row.message_id);
        }
        const senders = this.db
          .prepare('SELECT user_id,sender FROM sender_cache')
          .all() as unknown as { user_id: string; sender: string }[];
        const updateSender = this.db.prepare(
          'UPDATE sender_cache SET sender=? WHERE user_id=? AND sender=?',
        );
        for (const row of senders)
          updateSender.run(
            privateStateIdentifiers(key, row.user_id).sender(row.sender),
            row.user_id,
            row.sender,
          );
        this.db.prepare('INSERT INTO beta_privacy_version(id,key_check) VALUES(1,?)').run(check);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  cleanup(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid time');
    const day = new Date(now).toISOString().slice(0, 10);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM beta_email_content WHERE expires_at <= ?').run(now);
      this.db
        .prepare(
          `DELETE FROM beta_read_attempts WHERE EXISTS
        (SELECT 1 FROM beta_deleted_quota q WHERE q.subject=beta_read_attempts.subject AND q.day < ? AND beta_read_attempts.day <= q.day)`,
        )
        .run(day);
      this.db
        .prepare(
          `DELETE FROM llm_calls WHERE EXISTS
        (SELECT 1 FROM beta_deleted_quota q WHERE q.subject=llm_calls.user_id AND q.day < ? AND llm_calls.day <= q.day)`,
        )
        .run(day);
      this.db.prepare('DELETE FROM beta_deleted_quota WHERE day < ?').run(day);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The subject and email must come from an authenticated, revalidated session. */
  delete(subject: string, email: string, scope: DeletionScope, now: number): void {
    if (!subject || !email || !Number.isSafeInteger(now) || now < 0)
      throw new Error('invalid deletion context');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Stop and fence in the same transaction as deletion. An already-dispatched request may finish.
      this.db
        .prepare(
          `INSERT INTO beta_processing_controls(subject,running) VALUES(?,0)
        ON CONFLICT(subject) DO UPDATE SET running=0,scanned_backlog_days=NULL`,
        )
        .run(subject);
      this.db.prepare('UPDATE beta_worker_leases SET expires_at=0 WHERE subject=?').run(subject);
      if (scope === 'content' || scope === 'all' || scope === 'account')
        this.db.prepare('DELETE FROM beta_email_content WHERE user_id=?').run(subject);
      if (scope === 'decisions' || scope === 'all' || scope === 'account') {
        this.db.prepare('DELETE FROM decisions WHERE user_id=?').run(subject);
        this.db.prepare('DELETE FROM sender_cache WHERE user_id=?').run(subject);
      }
      if (scope === 'account') {
        const fence = this.db
          .prepare('SELECT revoking FROM beta_gmail_consent_fences WHERE subject=?')
          .get(subject) as { revoking: number } | undefined;
        if (fence?.revoking) throw new Error('Gmail revocation in progress');
        if (this.db.prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject=?').get(subject))
          throw new Error('Gmail connection must be revoked before deleting account');
        invalidateConsent(this.db, subject);
        this.db.prepare('DELETE FROM beta_gmail_consent_states WHERE subject=?').run(subject);
        this.db.prepare('DELETE FROM beta_access_requests WHERE subject=?').run(subject);
        this.db
          .prepare(
            'DELETE FROM beta_applications WHERE subject=? OR (subject IS NULL AND email=? COLLATE NOCASE)',
          )
          .run(subject, email);
        this.db
          .prepare('DELETE FROM beta_application_verifications WHERE email=? COLLATE NOCASE')
          .run(email);
        this.db
          .prepare(
            'DELETE FROM beta_notification_outbox WHERE email=? COLLATE NOCASE AND (lease_until IS NULL OR lease_until<=?)',
          )
          .run(email, now);
        this.db.prepare('DELETE FROM beta_sessions WHERE subject=?').run(subject);
      }
      if (scope === 'other' || scope === 'all' || scope === 'account') {
        this.db.prepare('DELETE FROM beta_user_configs WHERE subject=?').run(subject);
        this.db.prepare('DELETE FROM kv WHERE user_id=?').run(subject);
        this.db.prepare('DELETE FROM beta_processing_events WHERE subject=?').run(subject);
        this.db.prepare('DELETE FROM beta_cycle_metrics WHERE subject=?').run(subject);
        this.db.prepare('DELETE FROM beta_access_audit WHERE target=?').run(subject);
        this.db.prepare("UPDATE beta_access_audit SET actor='deleted' WHERE actor=?").run(subject);
        // Keep today's quota counters and safety fences; otherwise deleting and reapplying can bypass limits or revive old work.
        this.db
          .prepare('DELETE FROM beta_read_attempts WHERE subject=? AND day<>?')
          .run(subject, new Date(now).toISOString().slice(0, 10));
        this.db
          .prepare('DELETE FROM llm_calls WHERE user_id=? AND day<>?')
          .run(subject, new Date(now).toISOString().slice(0, 10));
        this.db
          .prepare(
            `INSERT INTO beta_deleted_quota(subject,day) VALUES(?,?)
          ON CONFLICT(subject) DO UPDATE SET day=excluded.day`,
          )
          .run(subject, new Date(now).toISOString().slice(0, 10));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
