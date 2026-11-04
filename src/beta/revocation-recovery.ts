import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { invalidateConsent } from './consent-fence.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export const REVOCATION_RECOVERY_CONFIRMATION = 'GOOGLE_GRANT_REVOKED';

/**
 * Offline operator recovery only. The operator MUST stop every beta instance and confirm the
 * user has revoked the grant at Google before calling. A scheduler-lease check is an additional
 * safeguard, not proof that no HTTP handler or provider request remains in flight.
 */
export function recoverRevocationOffline(
  databasePath: string,
  subject: string,
  confirmation: string,
  now: number,
): void {
  if (confirmation !== REVOCATION_RECOVERY_CONFIRMATION)
    throw new Error('explicit Google revocation confirmation required');
  if (!subject || subject.length > 255 || subject.trim() !== subject)
    throw new Error('invalid verified subject');
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999)
    throw new Error('invalid timestamp');
  if (!databasePath || databasePath === ':memory:' || !existsSync(databasePath))
    throw new Error('existing shared database required');

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA secure_delete = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM beta_scheduler_lease WHERE id = 1 AND expires_at > ?').get(now))
        throw new Error('stop all beta instances and wait for their leases to expire');
      const fence = db
        .prepare('SELECT revoking FROM beta_gmail_consent_fences WHERE subject = ?')
        .get(subject) as { revoking: number } | undefined;
      if (!fence || (fence.revoking !== 1 && fence.revoking !== 2))
        throw new Error('no interrupted or failed revocation');
      const token = db
        .prepare('SELECT enabled FROM beta_gmail_tokens WHERE subject = ?')
        .get(subject) as { enabled: number } | undefined;
      if (token?.enabled) throw new Error('refusing to remove an enabled connection');
      invalidateConsent(db, subject);
      db.prepare('DELETE FROM beta_gmail_tokens WHERE subject = ?').run(subject);
      db.prepare('UPDATE beta_gmail_consent_fences SET revoking = 0 WHERE subject = ?').run(
        subject,
      );
      db.prepare(
        `INSERT INTO beta_processing_controls (subject, running) VALUES (?, 0)
         ON CONFLICT(subject) DO UPDATE SET running = 0, scanned_backlog_days = NULL`,
      ).run(subject);
      db.prepare('UPDATE beta_worker_leases SET expires_at = 0 WHERE subject = ?').run(subject);
      db.prepare(
        `INSERT INTO beta_access_audit
        (actor, target, action, occurred_at, expires_at, daily_limit)
        VALUES ('system', ?, 'revocation_recovered_offline', ?, NULL, NULL)`,
      ).run(subject, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
