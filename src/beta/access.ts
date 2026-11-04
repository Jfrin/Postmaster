import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { GmailRequestKind } from '../gmail.js';
import { parseConfig } from '../config.js';
import type { CycleStats } from '../pipeline.js';
import { initConsentFence, invalidateConsent } from './consent-fence.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export const DEFAULT_DAILY_READ_LIMIT = 100;

export class AccessDeniedError extends Error {}
export class DailyReadLimitError extends Error {}
export class LeaseLostError extends Error {}
export class LiveConfirmationRequiredError extends Error {}

export interface WorkerLease {
  subject: string;
  owner: string;
  fence: number;
  scheduler?: SchedulerLease;
}

export interface SchedulerLease {
  owner: string;
  fence: number;
}

export interface AccessRequest {
  subject: string;
  email: string;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: number;
  expiresAt: number | null;
  dailyLimit: number;
}

export interface BetaApplication {
  email: string;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: number;
  expiresAt: number | null;
  dailyLimit: number;
  subject: string | null;
}

interface AccountRow {
  subject: string;
  email: string;
  status: AccessRequest['status'];
  requested_at: number;
  expires_at: number | null;
  daily_limit: number;
}

function checkSubject(subject: string): void {
  if (!subject || subject.length > 255 || subject.trim() !== subject) {
    throw new Error('invalid verified subject');
  }
}

function checkTime(time: number): void {
  if (!Number.isSafeInteger(time) || time < 0 || time > 253_402_300_799_999) {
    throw new Error('invalid timestamp');
  }
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function checkLeaseInput(subject: string, owner: string, now: number, ttlMs?: number): void {
  checkSubject(subject);
  checkTime(now);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(owner)) throw new Error('invalid lease owner');
  if (ttlMs !== undefined) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000)
      throw new Error('invalid lease duration');
    checkTime(now + ttlMs);
  }
}

/**
 * Local beta access policy, not an authentication system or a public API.
 * Callers MUST obtain subject and email from a verified Google identity, never request bodies.
 * Gmail processing must separately enforce these decisions at the network boundary.
 */
export class BetaAccessStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    initConsentFence(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS beta_admins (subject TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS beta_applications (
        email TEXT PRIMARY KEY COLLATE NOCASE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
        requested_at INTEGER NOT NULL, expires_at INTEGER,
        daily_limit INTEGER NOT NULL DEFAULT 100 CHECK (daily_limit >= 0),
        subject TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS beta_application_rate (
        id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS beta_access_requests (
        subject TEXT PRIMARY KEY, email TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
        requested_at INTEGER NOT NULL, expires_at INTEGER,
        daily_limit INTEGER NOT NULL DEFAULT 100 CHECK (daily_limit >= 0)
      );
      CREATE TABLE IF NOT EXISTS beta_read_attempts (
        subject TEXT NOT NULL, day TEXT NOT NULL, attempts INTEGER NOT NULL,
        PRIMARY KEY (subject, day)
      );
      CREATE TABLE IF NOT EXISTS beta_access_audit (
        id INTEGER PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL,
        action TEXT NOT NULL, occurred_at INTEGER NOT NULL, expires_at INTEGER, daily_limit INTEGER
      );
      CREATE TABLE IF NOT EXISTS beta_worker_leases (
        subject TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS beta_processing_controls (
        subject TEXT PRIMARY KEY, running INTEGER NOT NULL CHECK (running IN (0, 1)),
        scanned_backlog_days INTEGER, generation INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS beta_cycle_metrics (
        subject TEXT NOT NULL, day TEXT NOT NULL, cycles INTEGER NOT NULL,
        seen INTEGER NOT NULL, processed INTEGER NOT NULL, failed INTEGER NOT NULL, stopped INTEGER NOT NULL,
        PRIMARY KEY (subject, day)
      );
      CREATE TABLE IF NOT EXISTS beta_scheduler_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(beta_processing_controls)').all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === 'scanned_backlog_days')) {
        this.db.exec(
          'ALTER TABLE beta_processing_controls ADD COLUMN scanned_backlog_days INTEGER',
        );
      }
      if (!columns.some((column) => column.name === 'generation')) {
        this.db.exec(
          'ALTER TABLE beta_processing_controls ADD COLUMN generation INTEGER NOT NULL DEFAULT 0',
        );
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

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireAdmin(subject: string): void {
    checkSubject(subject);
    if (!this.isAdmin(subject)) {
      throw new AccessDeniedError('administrator required');
    }
  }

  isAdmin(subject: string): boolean {
    checkSubject(subject);
    return !!this.db.prepare('SELECT 1 FROM beta_admins WHERE subject = ?').get(subject);
  }

  /** Only invoke from a trusted deployment/bootstrap path, never from an HTTP request. */
  bootstrapAdmin(subject: string): void {
    checkSubject(subject);
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM beta_admins LIMIT 1').get()) {
        throw new AccessDeniedError('administrator already bootstrapped');
      }
      this.db.prepare('INSERT INTO beta_admins (subject) VALUES (?)').run(subject);
    });
  }

  /** Public email applications are unverified; never treat them as a Google identity. */
  submitApplication(email: string, now: number): boolean {
    checkTime(now);
    return this.transaction(() => {
      const rate = this.db
        .prepare('SELECT window_start, attempts FROM beta_application_rate WHERE id = 1')
        .get() as { window_start: number; attempts: number } | undefined;
      if (!rate || now >= rate.window_start + 3_600_000) {
        this.db
          .prepare(
            `INSERT INTO beta_application_rate (id, window_start, attempts) VALUES (1, ?, 1)
          ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, attempts = 1`,
          )
          .run(now);
      } else {
        if (now < rate.window_start || rate.attempts >= 100) return false;
        this.db
          .prepare('UPDATE beta_application_rate SET attempts = attempts + 1 WHERE id = 1')
          .run();
      }
      const count = this.db.prepare('SELECT count(*) AS n FROM beta_applications').get() as {
        n: number;
      };
      if (count.n >= 5000) return false;
      this.db
        .prepare(
          `INSERT INTO beta_applications (email, status, requested_at, daily_limit)
        VALUES (?, 'pending', ?, ?) ON CONFLICT(email) DO NOTHING`,
        )
        .run(email.toLowerCase(), now, DEFAULT_DAILY_READ_LIMIT);
      return true;
    });
  }

  listApplications(actor: string): BetaApplication[] {
    this.requireAdmin(actor);
    const rows = this.db
      .prepare('SELECT * FROM beta_applications ORDER BY requested_at DESC')
      .all() as unknown as {
      email: string;
      status: BetaApplication['status'];
      requested_at: number;
      expires_at: number | null;
      daily_limit: number;
      subject: string | null;
    }[];
    return rows.map((row) => ({
      email: row.email,
      status: row.status,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      dailyLimit: row.daily_limit,
      subject: row.subject,
    }));
  }

  decideApplication(
    actor: string,
    email: string,
    status: 'approved' | 'denied',
    expiresAt: number | null,
    dailyLimit: number,
    now: number,
  ): void {
    checkTime(now);
    if (status === 'approved') {
      if (expiresAt === null) throw new Error('approval expiry required');
      checkTime(expiresAt);
      if (expiresAt <= now) throw new Error('approval must expire in the future');
    }
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100_000)
      throw new Error('invalid daily limit');
    this.transaction(() => {
      this.requireAdmin(actor);
      const app = this.db
        .prepare('SELECT subject FROM beta_applications WHERE email = ? COLLATE NOCASE')
        .get(email) as { subject: string | null } | undefined;
      if (!app) throw new Error('application not found');
      this.db
        .prepare(
          'UPDATE beta_applications SET status = ?, expires_at = ?, daily_limit = ? WHERE email = ? COLLATE NOCASE',
        )
        .run(status, status === 'approved' ? expiresAt : null, dailyLimit, email);
      if (app.subject) {
        const prior = this.account(app.subject);
        if (prior) {
          if (status === 'denied') {
            this.db
              .prepare("UPDATE beta_access_requests SET status = 'denied' WHERE subject = ?")
              .run(app.subject);
            invalidateConsent(this.db, app.subject);
            this.stopWithinTransaction(app.subject);
          } else {
            this.db
              .prepare(
                "UPDATE beta_access_requests SET status = 'approved', expires_at = ?, daily_limit = ? WHERE subject = ?",
              )
              .run(expiresAt, dailyLimit, app.subject);
            if (prior.status !== 'approved' || prior.expires_at === null || prior.expires_at <= now)
              this.stopWithinTransaction(app.subject);
          }
          this.audit(actor, app.subject, status, now, expiresAt, dailyLimit);
        }
      }
    });
  }

  /** Bind an approved email once, only after Google verifies the signed-in account. */
  claimApplication(subject: string, verifiedEmail: string, now: number): boolean {
    checkSubject(subject);
    checkTime(now);
    return this.transaction(() => {
      const app = this.db
        .prepare('SELECT * FROM beta_applications WHERE email = ? COLLATE NOCASE')
        .get(verifiedEmail) as
        | { status: string; subject: string | null; expires_at: number | null; daily_limit: number }
        | undefined;
      if (
        !app ||
        app.status !== 'approved' ||
        app.expires_at === null ||
        app.expires_at <= now ||
        (app.subject && app.subject !== subject)
      )
        return false;
      const bound = this.db
        .prepare('SELECT email FROM beta_applications WHERE subject = ?')
        .get(subject) as { email: string } | undefined;
      if (bound && bound.email.toLowerCase() !== verifiedEmail.toLowerCase()) return false;
      if (!app.subject) {
        this.db
          .prepare('UPDATE beta_applications SET subject = ? WHERE email = ? COLLATE NOCASE')
          .run(subject, verifiedEmail);
        this.db
          .prepare(
            `INSERT INTO beta_access_requests (subject, email, status, requested_at, expires_at, daily_limit)
          VALUES (?, ?, 'approved', ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET email = excluded.email,
          status = 'approved', expires_at = excluded.expires_at, daily_limit = excluded.daily_limit`,
          )
          .run(subject, verifiedEmail, now, app.expires_at, app.daily_limit);
        this.stopWithinTransaction(subject);
      }
      return true;
    });
  }

  isApplicationAdmitted(subject: string, verifiedEmail: string, now: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM beta_applications WHERE subject = ? AND email = ? COLLATE NOCASE
      AND status = 'approved' AND expires_at > ?`,
      )
      .get(subject, verifiedEmail, now);
    return !!row && this.isActive(subject, now);
  }

  /** Start or renew a request; an already active approval is never shortened by requesting. */
  requestAccess(subject: string, verifiedEmail: string, now: number): void {
    checkSubject(subject);
    checkTime(now);
    if (!verifiedEmail || verifiedEmail.length > 320 || /[\r\n]/.test(verifiedEmail)) {
      throw new Error('invalid verified email');
    }
    this.transaction(() => {
      const row = this.account(subject);
      if (row?.status === 'approved' && row.expires_at !== null && row.expires_at > now) {
        this.db
          .prepare('UPDATE beta_access_requests SET email = ? WHERE subject = ?')
          .run(verifiedEmail, subject);
        return;
      }
      this.db
        .prepare(
          `
        INSERT INTO beta_access_requests (subject, email, status, requested_at, expires_at, daily_limit)
        VALUES (?, ?, 'pending', ?, NULL, ?)
        ON CONFLICT(subject) DO UPDATE SET email = excluded.email, status = 'pending',
          requested_at = excluded.requested_at
      `,
        )
        .run(subject, verifiedEmail, now, DEFAULT_DAILY_READ_LIMIT);
      if (row?.status !== 'pending') invalidateConsent(this.db, subject);
      this.stopWithinTransaction(subject);
    });
  }

  private account(subject: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM beta_access_requests WHERE subject = ?').get(subject) as
      AccountRow | undefined;
  }

  /** Subject must come from the authenticated session, not an API parameter. */
  ownRequest(subject: string): AccessRequest | null {
    checkSubject(subject);
    const row = this.account(subject);
    return row
      ? {
          subject: row.subject,
          email: row.email,
          status: row.status,
          requestedAt: row.requested_at,
          expiresAt: row.expires_at,
          dailyLimit: row.daily_limit,
        }
      : null;
  }

  private audit(
    actor: string,
    target: string,
    action: string,
    now: number,
    expiry: number | null,
    limit: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO beta_access_audit
      (actor, target, action, occurred_at, expires_at, daily_limit) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(actor, target, action, now, expiry, limit);
  }

  approve(
    actor: string,
    subject: string,
    expiresAt: number,
    dailyLimit: number,
    now: number,
  ): void {
    checkSubject(subject);
    checkTime(now);
    checkTime(expiresAt);
    if (expiresAt <= now) throw new Error('approval must expire in the future');
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100_000) {
      throw new Error('invalid daily read limit');
    }
    this.transaction(() => {
      this.requireAdmin(actor);
      const prior = this.account(subject);
      if (!prior) throw new Error('request not found');
      const wasActive =
        prior.status === 'approved' && prior.expires_at !== null && prior.expires_at > now;
      this.db
        .prepare(
          `UPDATE beta_access_requests SET status = 'approved', expires_at = ?, daily_limit = ?
        WHERE subject = ?`,
        )
        .run(expiresAt, dailyLimit, subject);
      if (!wasActive) this.stopWithinTransaction(subject);
      this.audit(actor, subject, 'approved', now, expiresAt, dailyLimit);
    });
  }

  deny(actor: string, subject: string, now: number): void {
    checkSubject(subject);
    checkTime(now);
    this.transaction(() => {
      this.requireAdmin(actor);
      if (!this.account(subject)) throw new Error('request not found');
      this.db
        .prepare("UPDATE beta_access_requests SET status = 'denied' WHERE subject = ?")
        .run(subject);
      invalidateConsent(this.db, subject);
      this.stopWithinTransaction(subject);
      this.audit(actor, subject, 'denied', now, null, null);
    });
  }

  listRequests(actor: string): AccessRequest[] {
    this.requireAdmin(actor);
    return (
      this.db
        .prepare('SELECT * FROM beta_access_requests ORDER BY requested_at DESC')
        .all() as unknown as AccountRow[]
    ).map((row) => ({
      subject: row.subject,
      email: row.email,
      status: row.status,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      dailyLimit: row.daily_limit,
    }));
  }

  isActive(subject: string, now: number): boolean {
    checkSubject(subject);
    checkTime(now);
    const row = this.account(subject);
    return row?.status === 'approved' && row.expires_at !== null && row.expires_at > now;
  }

  /** Reserve before every Gmail message-read attempt, including retries. Reset is midnight UTC. */
  reserveRead(subject: string, now: number): number {
    checkSubject(subject);
    checkTime(now);
    return this.transaction(() => {
      const row = this.activeAccount(subject, now);
      return this.countRead(row, subject, now);
    });
  }

  private activeAccount(subject: string, now: number): AccountRow {
    const row = this.account(subject);
    if (!row || row.status !== 'approved' || row.expires_at === null || row.expires_at <= now) {
      throw new AccessDeniedError('access not active');
    }
    return row;
  }

  private countRead(row: AccountRow, subject: string, now: number): number {
    const day = utcDay(now);
    const current = this.db
      .prepare('SELECT attempts FROM beta_read_attempts WHERE subject = ? AND day = ?')
      .get(subject, day) as { attempts: number } | undefined;
    if ((current?.attempts ?? 0) >= row.daily_limit)
      throw new DailyReadLimitError('daily read limit reached');
    this.db
      .prepare(
        `INSERT INTO beta_read_attempts (subject, day, attempts) VALUES (?, ?, 1)
      ON CONFLICT(subject, day) DO UPDATE SET attempts = attempts + 1`,
      )
      .run(subject, day);
    return (current?.attempts ?? 0) + 1;
  }

  /** Check access and the enabled connection atomically, counting full-message attempts. */
  authorizeGmailAttempt(subject: string, now: number, kind: GmailRequestKind): void {
    checkSubject(subject);
    checkTime(now);
    this.transaction(() => {
      const row = this.activeAccount(subject, now);
      const enabled = this.db
        .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
        .get(subject);
      if (!enabled) throw new AccessDeniedError('Gmail connection not active');
      if (kind === 'message_read') this.countRead(row, subject, now);
    });
  }

  /** Caller must derive subject from the verified owner's session. */
  startProcessing(subject: string, now: number): void {
    checkSubject(subject);
    checkTime(now);
    this.transaction(() => this.startWithinTransaction(subject, now));
  }

  /** Re-read configuration and start atomically; do not trust a prior browser preview. */
  startProcessingWithConfirmation(subject: string, now: number, confirmLive: boolean): void {
    checkSubject(subject);
    checkTime(now);
    this.transaction(() => {
      this.activeAccount(subject, now);
      const row = this.db
        .prepare('SELECT yaml FROM beta_user_configs WHERE subject = ?')
        .get(subject) as { yaml: string } | undefined;
      if (!row) throw new Error('configuration not initialized');
      if (!parseConfig(row.yaml).settings.dry_run && !confirmLive)
        throw new LiveConfirmationRequiredError('live-mode confirmation required');
      this.startWithinTransaction(subject, now);
    });
  }

  private startWithinTransaction(subject: string, now: number): void {
    this.activeAccount(subject, now);
    if (
      !this.db
        .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
        .get(subject)
    ) {
      throw new AccessDeniedError('Gmail connection not active');
    }
    const alreadyRunning = this.processingRequested(subject);
    this.db
      .prepare(
        `INSERT INTO beta_processing_controls (subject, running, generation) VALUES (?, 1, 1)
        ON CONFLICT(subject) DO UPDATE SET running = 1,
          generation = CASE WHEN beta_processing_controls.running = 0
            THEN beta_processing_controls.generation + 1 ELSE beta_processing_controls.generation END`,
      )
      .run(subject);
    if (!alreadyRunning) {
      this.db
        .prepare(
          'UPDATE beta_processing_controls SET scanned_backlog_days = NULL WHERE subject = ?',
        )
        .run(subject);
      this.db
        .prepare('UPDATE beta_worker_leases SET expires_at = 0 WHERE subject = ?')
        .run(subject);
    }
  }

  /** Safe to call after expiry so the owner can always stop future work. */
  stopProcessing(subject: string): void {
    checkSubject(subject);
    this.transaction(() => this.stopWithinTransaction(subject));
  }

  private stopWithinTransaction(subject: string): void {
    this.db
      .prepare(
        `INSERT INTO beta_processing_controls (subject, running) VALUES (?, 0)
        ON CONFLICT(subject) DO UPDATE SET running = 0, scanned_backlog_days = NULL`,
      )
      .run(subject);
    this.db.prepare('UPDATE beta_worker_leases SET expires_at = 0 WHERE subject = ?').run(subject);
  }

  processingRequested(subject: string): boolean {
    checkSubject(subject);
    const row = this.db
      .prepare('SELECT running FROM beta_processing_controls WHERE subject = ?')
      .get(subject) as { running: number } | undefined;
    return row?.running === 1;
  }

  /** Trusted scheduler only; never expose this cross-user listing to ordinary users. */
  runnableUsers(now: number): { subject: string; generation: number }[] {
    checkTime(now);
    return this.db
      .prepare(
        `SELECT controls.subject, controls.generation FROM beta_processing_controls AS controls
      JOIN beta_access_requests AS access ON access.subject = controls.subject
      JOIN beta_gmail_tokens AS tokens ON tokens.subject = controls.subject
      WHERE controls.running = 1 AND access.status = 'approved' AND access.expires_at > ? AND tokens.enabled = 1
      ORDER BY controls.subject`,
      )
      .all(now) as unknown as { subject: string; generation: number }[];
  }

  schedulerHeld(lease: SchedulerLease, now: number): boolean {
    checkTime(now);
    if (
      !Number.isSafeInteger(lease.fence) ||
      lease.fence < 1 ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(lease.owner)
    )
      return false;
    return !!this.db
      .prepare(
        'SELECT 1 FROM beta_scheduler_lease WHERE id = 1 AND owner = ? AND fence = ? AND expires_at > ?',
      )
      .get(lease.owner, lease.fence, now);
  }

  /** Atomically elect one scheduler and reset all processing to stopped on takeover. */
  acquireScheduler(owner: string, now: number, ttlMs: number): SchedulerLease | null {
    checkLeaseInput('scheduler', owner, now, ttlMs);
    return this.transaction(() => {
      const current = this.db
        .prepare('SELECT fence, expires_at FROM beta_scheduler_lease WHERE id = 1')
        .get() as { fence: number; expires_at: number } | undefined;
      if (current && current.expires_at > now) return null;
      const fence = (current?.fence ?? 0) + 1;
      if (!Number.isSafeInteger(fence)) throw new Error('scheduler fence exhausted');
      this.db
        .prepare(
          `INSERT INTO beta_scheduler_lease (id, owner, fence, expires_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, fence = excluded.fence, expires_at = excluded.expires_at`,
        )
        .run(owner, fence, now + ttlMs);
      this.db.exec('UPDATE beta_processing_controls SET running = 0, scanned_backlog_days = NULL');
      this.db.exec('UPDATE beta_worker_leases SET expires_at = 0');
      return { owner, fence };
    });
  }

  renewScheduler(lease: SchedulerLease, now: number, ttlMs: number): boolean {
    checkLeaseInput('scheduler', lease.owner, now, ttlMs);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) return false;
    const result = this.db
      .prepare(
        `UPDATE beta_scheduler_lease SET expires_at = ?
      WHERE id = 1 AND owner = ? AND fence = ? AND expires_at > ?`,
      )
      .run(now + ttlMs, lease.owner, lease.fence, now);
    return Number(result.changes) === 1;
  }

  /** A stale scheduler cannot stop or reset the current scheduler's work. */
  releaseScheduler(lease: SchedulerLease, now: number): void {
    checkLeaseInput('scheduler', lease.owner, now);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) return;
    this.transaction(() => {
      if (!this.schedulerHeld(lease, now)) return;
      this.db.exec('UPDATE beta_processing_controls SET running = 0, scanned_backlog_days = NULL');
      this.db.exec('UPDATE beta_worker_leases SET expires_at = 0');
      this.db.prepare('UPDATE beta_scheduler_lease SET expires_at = 0 WHERE id = 1').run();
    });
  }

  /** Acquire only for an active, connected user; the owner must be a random worker identifier. */
  acquireLease(
    subject: string,
    owner: string,
    now: number,
    ttlMs: number,
    scheduler?: SchedulerLease,
  ): WorkerLease | null {
    checkLeaseInput(subject, owner, now, ttlMs);
    return this.transaction(() => {
      if (scheduler && !this.schedulerHeld(scheduler, now))
        throw new LeaseLostError('scheduler lease lost');
      this.activeAccount(subject, now);
      if (!this.processingRequested(subject)) throw new AccessDeniedError('processing is stopped');
      if (
        !this.db
          .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
          .get(subject)
      ) {
        throw new AccessDeniedError('Gmail connection not active');
      }
      const current = this.db
        .prepare('SELECT fence, expires_at FROM beta_worker_leases WHERE subject = ?')
        .get(subject) as { fence: number; expires_at: number } | undefined;
      if (current && current.expires_at > now) return null;
      const fence = (current?.fence ?? 0) + 1;
      if (!Number.isSafeInteger(fence)) throw new Error('lease fence exhausted');
      this.db
        .prepare(
          `INSERT INTO beta_worker_leases (subject, owner, fence, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(subject) DO UPDATE SET owner = excluded.owner, fence = excluded.fence, expires_at = excluded.expires_at`,
        )
        .run(subject, owner, fence, now + ttlMs);
      return { subject, owner, fence, ...(scheduler ? { scheduler } : {}) };
    });
  }

  renewLease(lease: WorkerLease, now: number, ttlMs: number): boolean {
    checkLeaseInput(lease.subject, lease.owner, now, ttlMs);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) return false;
    return this.transaction(() => {
      if (
        (lease.scheduler && !this.schedulerHeld(lease.scheduler, now)) ||
        !this.isActive(lease.subject, now) ||
        !this.processingRequested(lease.subject) ||
        !this.db
          .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
          .get(lease.subject)
      )
        return false;
      const result = this.db
        .prepare(
          `UPDATE beta_worker_leases SET expires_at = ?
        WHERE subject = ? AND owner = ? AND fence = ? AND expires_at > ?`,
        )
        .run(now + ttlMs, lease.subject, lease.owner, lease.fence, now);
      return Number(result.changes) === 1;
    });
  }

  releaseLease(lease: WorkerLease): void {
    checkLeaseInput(lease.subject, lease.owner, 0);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) return;
    this.db
      .prepare(
        'UPDATE beta_worker_leases SET expires_at = 0 WHERE subject = ? AND owner = ? AND fence = ?',
      )
      .run(lease.subject, lease.owner, lease.fence);
  }

  /** The worker must recheck its fence at each Gmail call; already in-flight calls can finish. */
  authorizeLeasedGmailAttempt(
    lease: WorkerLease,
    now: number | (() => number),
    kind: GmailRequestKind,
  ): void {
    checkLeaseInput(lease.subject, lease.owner, 0);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1)
      throw new LeaseLostError('lease lost');
    const checkedAt = this.transaction(() => {
      // BEGIN IMMEDIATE can wait on another writer; sample only after acquiring the lock.
      const time = typeof now === 'function' ? now() : now;
      checkTime(time);
      const row = this.leasedAccount(lease, time);
      if (kind === 'message_read') this.countRead(row, lease.subject, time);
      return time;
    });
    if (typeof now === 'function') {
      const afterCommit = now();
      checkTime(afterCommit);
      // Recheck time-based expiry after a potentially slow commit. A concurrent Stop after
      // this check still cannot be made atomic with network dispatch.
      const account = this.leasedAccount(lease, afterCommit);
      const worker = this.db
        .prepare(
          'SELECT expires_at FROM beta_worker_leases WHERE subject = ? AND owner = ? AND fence = ?',
        )
        .get(lease.subject, lease.owner, lease.fence) as { expires_at: number } | undefined;
      const scheduler = lease.scheduler
        ? (this.db
            .prepare(
              'SELECT expires_at FROM beta_scheduler_lease WHERE id = 1 AND owner = ? AND fence = ?',
            )
            .get(lease.scheduler.owner, lease.scheduler.fence) as
            { expires_at: number } | undefined)
        : undefined;
      const finalTime = now();
      checkTime(finalTime);
      if (kind === 'message_read' && utcDay(finalTime) !== utcDay(checkedAt)) {
        throw new Error('UTC day changed during Gmail authorization');
      }
      if (account.expires_at === null || account.expires_at <= finalTime) {
        throw new AccessDeniedError('access not active');
      }
      if (
        !worker ||
        worker.expires_at <= finalTime ||
        (lease.scheduler && (!scheduler || scheduler.expires_at <= finalTime))
      ) {
        throw new LeaseLostError('lease lost');
      }
    }
  }

  private leasedAccount(lease: WorkerLease, now: number): AccountRow {
    if (lease.scheduler && !this.schedulerHeld(lease.scheduler, now))
      throw new LeaseLostError('scheduler lease lost');
    const row = this.activeAccount(lease.subject, now);
    if (!this.processingRequested(lease.subject))
      throw new AccessDeniedError('processing is stopped');
    if (
      !this.db
        .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
        .get(lease.subject)
    ) {
      throw new AccessDeniedError('Gmail connection not active');
    }
    const held = this.db
      .prepare(
        `SELECT 1 FROM beta_worker_leases
      WHERE subject = ? AND owner = ? AND fence = ? AND expires_at > ?`,
      )
      .get(lease.subject, lease.owner, lease.fence, now);
    if (!held) throw new LeaseLostError('lease lost');
    return row;
  }

  needsBacklogScan(lease: WorkerLease, days: number, now: number): boolean {
    checkLeaseInput(lease.subject, lease.owner, now);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1)
      throw new LeaseLostError('lease lost');
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('invalid backlog');
    return this.transaction(() => {
      this.leasedAccount(lease, now);
      const row = this.db
        .prepare('SELECT scanned_backlog_days FROM beta_processing_controls WHERE subject = ?')
        .get(lease.subject) as { scanned_backlog_days: number | null };
      return row.scanned_backlog_days !== days;
    });
  }

  completeBacklogScan(lease: WorkerLease, days: number, now: number): void {
    checkLeaseInput(lease.subject, lease.owner, now);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1)
      throw new LeaseLostError('lease lost');
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('invalid backlog');
    this.transaction(() => {
      this.leasedAccount(lease, now);
      this.db
        .prepare('UPDATE beta_processing_controls SET scanned_backlog_days = ? WHERE subject = ?')
        .run(days, lease.subject);
    });
  }

  /** Record only aggregate counters while this worker still owns its lease. */
  recordCycle(lease: WorkerLease, stats: CycleStats, now: number): void {
    checkLeaseInput(lease.subject, lease.owner, now);
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1)
      throw new LeaseLostError('lease lost');
    if (
      ![stats.seen, stats.processed, stats.failed].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      throw new Error('invalid cycle metrics');
    }
    this.transaction(() => {
      this.leasedAccount(lease, now);
      this.db
        .prepare(
          `INSERT INTO beta_cycle_metrics (subject, day, cycles, seen, processed, failed, stopped)
        VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(subject, day) DO UPDATE SET cycles = cycles + 1, seen = seen + excluded.seen,
          processed = processed + excluded.processed, failed = failed + excluded.failed, stopped = stopped + excluded.stopped`,
        )
        .run(
          lease.subject,
          new Date(now).toISOString().slice(0, 10),
          stats.seen,
          stats.processed,
          stats.failed,
          stats.stopped ? 1 : 0,
        );
    });
  }

  readUsage(
    actor: string,
    subject: string,
    now: number,
  ): { day: string; attempts: number; limit: number } {
    this.requireAdmin(actor);
    checkSubject(subject);
    checkTime(now);
    const row = this.account(subject);
    if (!row) throw new Error('request not found');
    const day = new Date(now).toISOString().slice(0, 10);
    const usage = this.db
      .prepare('SELECT attempts FROM beta_read_attempts WHERE subject = ? AND day = ?')
      .get(subject, day) as { attempts: number } | undefined;
    return { day, attempts: usage?.attempts ?? 0, limit: row.daily_limit };
  }

  cycleUsage(
    actor: string,
    subject: string,
    now: number,
  ): { cycles: number; seen: number; processed: number; failed: number; stopped: number } {
    this.requireAdmin(actor);
    checkSubject(subject);
    checkTime(now);
    if (!this.account(subject)) throw new Error('request not found');
    const row = this.db
      .prepare(
        `SELECT cycles, seen, processed, failed, stopped FROM beta_cycle_metrics
      WHERE subject = ? AND day = ?`,
      )
      .get(subject, new Date(now).toISOString().slice(0, 10)) as
      | { cycles: number; seen: number; processed: number; failed: number; stopped: number }
      | undefined;
    return row ?? { cycles: 0, seen: 0, processed: 0, failed: 0, stopped: 0 };
  }

  /** Only aggregate counts; no mailbox content, subjects, or sender addresses. */
  metrics(
    actor: string,
    now: number,
  ): {
    pending: number;
    active: number;
    expired: number;
    denied: number;
    readsToday: number;
    cyclesToday: number;
    processedToday: number;
    failedToday: number;
  } {
    this.requireAdmin(actor);
    checkTime(now);
    const requests = this.db
      .prepare(
        `SELECT
      COALESCE(SUM(status = 'pending'), 0) AS pending,
      COALESCE(SUM(status = 'approved' AND expires_at > ?), 0) AS active,
      COALESCE(SUM(status = 'approved' AND expires_at <= ?), 0) AS expired,
      COALESCE(SUM(status = 'denied'), 0) AS denied FROM beta_access_requests`,
      )
      .get(now, now) as {
      pending: number;
      active: number;
      expired: number;
      denied: number;
    };
    const reads = this.db
      .prepare('SELECT COALESCE(SUM(attempts), 0) AS count FROM beta_read_attempts WHERE day = ?')
      .get(new Date(now).toISOString().slice(0, 10)) as { count: number };
    const cycles = this.db
      .prepare(
        `SELECT COALESCE(SUM(cycles), 0) AS cycles,
      COALESCE(SUM(processed), 0) AS processed, COALESCE(SUM(failed), 0) AS failed
      FROM beta_cycle_metrics WHERE day = ?`,
      )
      .get(new Date(now).toISOString().slice(0, 10)) as {
      cycles: number;
      processed: number;
      failed: number;
    };
    return {
      ...requests,
      readsToday: reads.count,
      cyclesToday: cycles.cycles,
      processedToday: cycles.processed,
      failedToday: cycles.failed,
    };
  }
}
