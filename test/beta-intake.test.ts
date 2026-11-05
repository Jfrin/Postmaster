import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { BetaAccessStore, DENIAL_REAPPLICATION_COOLDOWN_MS } from '../src/beta/access.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const now = Date.parse('2026-11-04T10:00:00Z');

describe('closed beta intake', () => {
  it('deletes a bound application and stops access without denial or a cooldown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-delete-application-'));
    const path = join(dir, 'beta.db');
    const store = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@example.com', now, true);
      store.decideApplication('owner', 'alice@example.com', 'approved', now + 60_000, 7, now, true);
      store.claimApplication('alice', 'alice@example.com', now);
      vault.save('alice', 'synthetic');
      store.startProcessing('alice', now);
      expect(() => store.deleteApplication('alice', 'alice@example.com', now + 1)).toThrow();
      expect(store.deleteApplication('owner', 'ALICE@example.com', now + 1)).toBe(true);
      expect(store.listApplications('owner')).toEqual([]);
      expect(store.ownRequest('alice')).toBeNull();
      expect(store.processingRequested('alice')).toBe(false);
      expect(store.isApplicationAdmitted('alice', 'alice@example.com', now + 1)).toBe(false);
      expect(store.notificationCounts('owner', false)).toEqual({ pending: 0, failed: 0 });
      expect(store.deleteApplication('owner', 'alice@example.com', now + 1)).toBe(false);
      expect(store.submitApplication('alice@example.com', now + 2)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([{ status: 'pending', subject: null }]);
    } finally {
      vault.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes an unbound denied application and permits immediate reapplication', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@example.com', now);
      store.decideApplication('owner', 'alice@example.com', 'denied', null, 7, now + 1);
      expect(store.deleteApplication('owner', 'alice@example.com', now + 2)).toBe(true);
      expect(store.submitApplication('alice@example.com', now + 3)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([{ status: 'pending' }]);
    } finally {
      store.close();
    }
  });
  it('deletes testing access without a denial or cooldown, and allows a fresh approval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-delete-access-'));
    const path = join(dir, 'beta.db');
    const store = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@example.com', now);
      store.decideApplication('owner', 'alice@example.com', 'approved', now + 60_000, 7, now, true);
      expect(store.claimApplication('alice', 'alice@example.com', now)).toBe(true);
      vault.save('alice', 'synthetic');
      store.startProcessing('alice', now);
      expect(store.processingRequested('alice')).toBe(true);
      expect(() => store.deleteAccess('alice', 'alice', now + 1)).toThrow();
      expect(store.isApplicationAdmitted('alice', 'alice@example.com', now + 1)).toBe(true);
      expect(store.deleteAccess('owner', 'alice', now + 1)).toBe(true);
      expect(store.processingRequested('alice')).toBe(false);
      expect(store.ownRequest('alice')).toBeNull();
      expect(store.isApplicationAdmitted('alice', 'alice@example.com', now + 1)).toBe(false);
      expect(store.claimNotification(now + 1, 'a'.repeat(24))).toBeNull();
      expect(store.listApplications('owner')).toMatchObject([{ status: 'pending', subject: null }]);
      expect(store.submitApplication('alice@example.com', now + 2, true)).toBe(true);
      expect(store.listApplications('owner')[0]!.status).toBe('pending');
      store.decideApplication('owner', 'alice@example.com', 'approved', now + 60_000, 7, now + 3);
      expect(store.claimApplication('alice', 'alice@example.com', now + 3)).toBe(true);
      expect(store.isApplicationAdmitted('alice', 'alice@example.com', now + 3)).toBe(true);
      expect(store.processingRequested('alice')).toBe(false);
      expect(store.deleteAccess('owner', 'missing', now + 4)).toBe(false);
    } finally {
      vault.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears a linked denial when its testing access is deleted', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@example.com', now);
      store.decideApplication('owner', 'alice@example.com', 'approved', now + 60_000, 7, now);
      store.claimApplication('alice', 'alice@example.com', now);
      store.decideApplication('owner', 'alice@example.com', 'denied', null, 7, now + 1, true);
      expect(store.deleteAccess('owner', 'alice', now + 2)).toBe(true);
      expect(store.submitApplication('alice@example.com', now + 3, true)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([{ status: 'pending', subject: null }]);
      expect(store.ownRequest('alice')).toBeNull();
      expect(store.notificationCounts('owner', false)).toEqual({ pending: 0, failed: 0 });
    } finally {
      store.close();
    }
  });

  it('also clears an unbound application for the verified access email', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      store.requestAccess('alice', 'Alice@example.com', now);
      store.submitApplication('alice@example.com', now);
      store.decideApplication('owner', 'alice@example.com', 'denied', null, 7, now + 1, true);
      expect(store.deleteAccess('owner', 'alice', now + 2)).toBe(true);
      expect(store.submitApplication('alice@example.com', now + 3)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([{ status: 'pending', subject: null }]);
      expect(store.notificationCounts('owner', false)).toEqual({ pending: 0, failed: 0 });
    } finally {
      store.close();
    }
  });

  it('allows a denied applicant to reapply after 24 hours without granting access', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@gmail.com', now);
      store.decideApplication('owner', 'alice@gmail.com', 'approved', now + 200_000_000, 7, now);
      expect(store.claimApplication('alice', 'alice@gmail.com', now)).toBe(true);
      store.decideApplication('owner', 'alice@gmail.com', 'denied', null, 7, now + 1);
      store.decideApplication('owner', 'alice@gmail.com', 'denied', null, 7, now + 2);
      const ready = now + 1 + DENIAL_REAPPLICATION_COOLDOWN_MS;
      expect(store.submitApplication('ALICE@gmail.com', ready - 1, true)).toBe(true);
      expect(store.listApplications('owner')[0]!.status).toBe('denied');
      expect(store.notificationCounts('owner', false).pending).toBe(0);
      expect(store.submitApplication('alice@gmail.com', ready, true)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([
        { status: 'pending', subject: 'alice' },
      ]);
      expect(store.isApplicationAdmitted('alice', 'alice@gmail.com', ready)).toBe(false);
      expect(store.ownRequest('alice')?.status).toBe('denied');
      expect(store.notificationCounts('owner', false).pending).toBe(1);
      expect(store.submitApplication('alice@gmail.com', ready + 1, true)).toBe(true);
      expect(store.notificationCounts('owner', false).pending).toBe(1);
    } finally {
      store.close();
    }
  });

  it('starts a full cooldown at migration for older denials with no timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-cooldown-'));
    const path = join(dir, 'beta.db');
    try {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE beta_applications (email TEXT PRIMARY KEY COLLATE NOCASE,
        status TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER,
        daily_limit INTEGER NOT NULL, subject TEXT UNIQUE);
        INSERT INTO beta_applications VALUES ('legacy@example.com', 'denied', 100, NULL, 7, NULL)`);
      db.close();
      let store = new BetaAccessStore(path, undefined, now);
      store.bootstrapAdmin('owner');
      expect(
        store.submitApplication('legacy@example.com', now + DENIAL_REAPPLICATION_COOLDOWN_MS - 1),
      ).toBe(true);
      expect(store.listApplications('owner')[0]!.status).toBe('denied');
      store.close();
      store = new BetaAccessStore(path, undefined, now + 10_000);
      expect(
        store.submitApplication('legacy@example.com', now + DENIAL_REAPPLICATION_COOLDOWN_MS),
      ).toBe(true);
      expect(store.listApplications('owner')[0]!.status).toBe('pending');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reset decisions on duplicate submissions and expires admitted accounts', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      expect(store.submitApplication('alice@gmail.com', now)).toBe(true);
      expect(store.claimApplication('alice', 'alice@gmail.com', now)).toBe(false);
      store.decideApplication('owner', 'alice@gmail.com', 'approved', now + 1000, 42, now);
      expect(store.submitApplication('ALICE@gmail.com', now + 1)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([
        { status: 'approved', dailyLimit: 42 },
      ]);
      expect(store.claimApplication('alice', 'alice@gmail.com', now + 2)).toBe(true);
      expect(store.isActive('alice', now + 2)).toBe(true);
      expect(store.isApplicationAdmitted('alice', 'alice@gmail.com', now + 1000)).toBe(false);
      expect(store.claimApplication('alice', 'alice@gmail.com', now + 1000)).toBe(false);
      store.decideApplication('owner', 'alice@gmail.com', 'approved', now + 2000, 100, now + 1001);
      expect(store.isApplicationAdmitted('alice', 'alice@gmail.com', now + 1002)).toBe(true);
      expect(store.processingRequested('alice')).toBe(false);
      store.decideApplication('owner', 'alice@gmail.com', 'denied', null, 100, now + 1003);
      expect(store.submitApplication('alice@gmail.com', now + 1004)).toBe(true);
      expect(store.listApplications('owner')[0]!.status).toBe('denied');
      expect(store.claimApplication('alice', 'alice@gmail.com', now + 1004)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('caps submission attempts across restarts of the request handler', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      for (let n = 0; n < 100; n++)
        expect(store.submitApplication('same@gmail.com', now)).toBe(true);
      expect(store.submitApplication('other@gmail.com', now)).toBe(false);
      expect(store.submitApplication('other@gmail.com', now + 3_600_000)).toBe(true);
    } finally {
      store.close();
    }
  });
});
