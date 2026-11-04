import type { DatabaseSync } from 'node:sqlite';

/** Call in each store's initialization so all shared-database operations use the same fence. */
export function initConsentFence(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS beta_gmail_consent_fences (
    subject TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0,
    revoking INTEGER NOT NULL DEFAULT 0 CHECK (revoking IN (0, 1, 2))
  )`);
}

/** Caller must already hold an immediate transaction. */
export function invalidateConsent(db: DatabaseSync, subject: string): void {
  db.prepare(
    `INSERT INTO beta_gmail_consent_fences (subject, generation) VALUES (?, 1)
    ON CONFLICT(subject) DO UPDATE SET generation = generation + 1`,
  ).run(subject);
}
