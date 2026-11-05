import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { BetaAccessStore } from '../src/beta/access.js';

const now = 1_000_000;
const key = Buffer.alloc(32, 7);
const lease = 'v'.repeat(24);
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

describe('application inbox verification', () => {
  it('queues a private code, submits only after verification, and does not grant Google access', () => {
    const store = new BetaAccessStore(':memory:', key);
    try {
      store.bootstrapAdmin('owner');
      expect(store.requestApplicationVerification('Alice@example.com', now)).toBe(true);
      expect(store.requestApplicationVerification('alice@example.com', now + 1)).toBe(true);
      expect(store.listApplications('owner')).toEqual([]);
      expect(store.notificationCounts('owner')).toEqual({ pending: 1, failed: 0 });
      const notice = store.claimNotification(now, lease)!;
      expect(notice).toMatchObject({
        email: 'alice@example.com',
        kind: 'verification',
        expiresAt: now + 1_800_000,
      });
      expect(notice.verificationCode).toMatch(/^\d{8}$/);
      store.finishNotification(notice.id, lease, now, true);
      expect(store.notificationCounts('owner')).toEqual({ pending: 0, failed: 0 });
      expect(store.verifyApplication('someone@example.com', notice.verificationCode!, now)).toBe(
        false,
      );
      expect(store.verifyApplication('alice@example.com', notice.verificationCode!, now)).toBe(
        true,
      );
      expect(store.verifyApplication('alice@example.com', notice.verificationCode!, now)).toBe(
        false,
      );
      expect(store.listApplications('owner')).toMatchObject([
        { email: 'alice@example.com', status: 'pending', emailVerifiedAt: now },
      ]);
      expect(store.claimApplication('alice', 'alice@example.com', now)).toBe(false);
      expect(store.claimNotification(now, lease)?.kind).toBe('application');
    } finally {
      store.close();
    }
  });

  it('locks guessing, expires codes, and rotates codes only after the resend cooldown', () => {
    const store = new BetaAccessStore(':memory:', key);
    try {
      store.bootstrapAdmin('owner');
      store.requestApplicationVerification('a@example.com', now);
      const first = store.claimNotification(now, lease)!;
      store.finishNotification(first.id, lease, now, true);
      const wrong = first.verificationCode === '00000000' ? '11111111' : '00000000';
      for (let i = 0; i < 5; i++)
        expect(store.verifyApplication('a@example.com', wrong, now)).toBe(false);
      expect(store.verifyApplication('a@example.com', first.verificationCode!, now)).toBe(false);
      store.requestApplicationVerification('a@example.com', now + 599_999);
      expect(store.claimNotification(now + 599_999, lease)).toBeNull();
      store.requestApplicationVerification('a@example.com', now + 600_000);
      const second = store.claimNotification(now + 600_000, lease)!;
      if (second.verificationCode !== first.verificationCode)
        expect(
          store.verifyApplication('a@example.com', first.verificationCode!, now + 600_000),
        ).toBe(false);
      expect(
        store.verifyApplication('a@example.com', second.verificationCode!, now + 2_400_000),
      ).toBe(false);
      expect(store.listApplications('owner')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('reports failed delivery and permits an administrator to retry before expiry', () => {
    const store = new BetaAccessStore(':memory:', key);
    try {
      store.bootstrapAdmin('owner');
      store.requestApplicationVerification('a@example.com', now);
      let at = now;
      for (const delay of [0, 60_000, 180_000, 420_000, 900_000]) {
        at = now + delay;
        const notice = store.claimNotification(at, lease)!;
        expect(notice.kind).toBe('verification');
        store.finishNotification(notice.id, lease, at, false);
      }
      expect(store.notificationCounts('owner')).toEqual({ pending: 0, failed: 1 });
      const failed = store.failedNotifications('owner')[0]!;
      expect(failed).toMatchObject({ email: 'a@example.com', kind: 'verification' });
      expect(failed.id).toBeLessThan(0);
      expect(() => store.retryNotification('other', failed.id, at)).toThrow();
      expect(store.retryNotification('owner', failed.id, at)).toBe(true);
      expect(store.claimNotification(at, lease)?.kind).toBe('verification');
    } finally {
      store.close();
    }
  });

  it('fails closed if the verification key is unavailable and leaves old applications unverified', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('legacy@example.com', now);
      expect(store.listApplications('owner')).toMatchObject([{ emailVerifiedAt: null }]);
      expect(() => store.requestApplicationVerification('a@example.com', now)).toThrow();
    } finally {
      store.close();
    }
  });

  it('lets a legacy applicant verify without changing an existing decision or sending a duplicate alert', () => {
    const store = new BetaAccessStore(':memory:', key);
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('legacy@example.com', now);
      store.decideApplication('owner', 'legacy@example.com', 'approved', now + 100_000, 5, now);
      store.requestApplicationVerification('legacy@example.com', now + 1);
      const notice = store.claimNotification(now + 1, lease)!;
      expect(notice.kind).toBe('verification');
      store.finishNotification(notice.id, lease, now + 1, true);
      expect(store.verifyApplication('legacy@example.com', notice.verificationCode!, now + 2)).toBe(
        true,
      );
      expect(store.listApplications('owner')).toMatchObject([
        { status: 'approved', dailyLimit: 5, emailVerifiedAt: now + 2 },
      ]);
      expect(store.notificationCounts('owner')).toEqual({ pending: 0, failed: 0 });
      expect(store.requestApplicationVerification('legacy@example.com', now + 3)).toBe(true);
      expect(store.claimNotification(now + 3, lease)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('preserves a code and its attempt limit across restarts without storing the code in the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-verify-'));
    const path = join(dir, 'beta.db');
    try {
      let store = new BetaAccessStore(path, key);
      store.bootstrapAdmin('owner');
      store.requestApplicationVerification('a@example.com', now);
      const notice = store.claimNotification(now, lease)!;
      store.finishNotification(notice.id, lease, now, true);
      const wrong = notice.verificationCode === '00000000' ? '11111111' : '00000000';
      for (let i = 0; i < 4; i++)
        expect(store.verifyApplication('a@example.com', wrong, now)).toBe(false);
      store.requestApplicationVerification('b@example.com', now);
      const second = store.claimNotification(now, lease)!;
      store.finishNotification(second.id, lease, now, true);
      store.close();
      const db = new DatabaseSync(path, { readOnly: true });
      const columns = db.prepare('PRAGMA table_info(beta_application_verifications)').all() as {
        name: string;
      }[];
      expect(columns.map((column) => column.name)).not.toContain('code');
      const rows = db.prepare('SELECT * FROM beta_application_verifications').all();
      expect(rows.flatMap((row) => Object.values(row))).not.toContain(notice.verificationCode);
      db.close();
      store = new BetaAccessStore(path, key);
      expect(store.verifyApplication('a@example.com', wrong, now)).toBe(false);
      expect(store.verifyApplication('a@example.com', notice.verificationCode!, now)).toBe(false);
      expect(store.verifyApplication('b@example.com', second.verificationCode!, now)).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates an existing application table without changing a prior decision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-legacy-'));
    const path = join(dir, 'beta.db');
    try {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE beta_applications (email TEXT PRIMARY KEY COLLATE NOCASE, status TEXT NOT NULL,
        requested_at INTEGER NOT NULL, expires_at INTEGER, daily_limit INTEGER NOT NULL, subject TEXT UNIQUE);
        INSERT INTO beta_applications VALUES ('legacy@example.com', 'approved', 100, 9999999, 7, NULL)`);
      db.close();
      const store = new BetaAccessStore(path, key);
      try {
        store.bootstrapAdmin('owner');
        expect(store.listApplications('owner')).toMatchObject([
          {
            email: 'legacy@example.com',
            status: 'approved',
            dailyLimit: 7,
            expiresAt: 9999999,
            emailVerifiedAt: null,
          },
        ]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
