import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import { deleteStaleGmailTokens, EXPIRED_TOKEN_RETENTION_MS } from '../src/beta/token-retention.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

describe('expired token retention foundation', () => {
  it('retains expired tokens for seven days, including while reapproval is pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-retention-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('user', 'test@example.com', now);
      const expiry = now + 1000;
      access.approve('admin', 'user', expiry, 100, now);
      vault.save('user', 'synthetic-refresh-token');
      access.requestAccess('user', 'test@example.com', expiry);
      expect(access.isActive('user', expiry)).toBe(false);
      expect(deleteStaleGmailTokens(path, expiry + EXPIRED_TOKEN_RETENTION_MS - 1)).toBe(0);
      expect(vault.load('user')).toBe('synthetic-refresh-token');
      expect(deleteStaleGmailTokens(path, expiry + EXPIRED_TOKEN_RETENTION_MS)).toBe(1);
      expect(vault.load('user')).toBeNull();
      expect(deleteStaleGmailTokens(path, expiry + EXPIRED_TOKEN_RETENTION_MS)).toBe(0);
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('does not delete a token if the user was reapproved before cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-retention-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('user', 'test@example.com', now);
      const expiry = now + 1000;
      access.approve('admin', 'user', expiry, 100, now);
      vault.save('user', 'synthetic-refresh-token');
      access.requestAccess('user', 'test@example.com', expiry);
      const reapproval = expiry + EXPIRED_TOKEN_RETENTION_MS - 1;
      access.approve('admin', 'user', reapproval + EXPIRED_TOKEN_RETENTION_MS * 2, 100, reapproval);
      expect(deleteStaleGmailTokens(path, reapproval + 1)).toBe(0);
      expect(vault.load('user')).toBe('synthetic-refresh-token');
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('does not delete a new pending connection using a previous approval expiry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-retention-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('user', 'test@example.com', now);
      const expiry = now + 1000;
      access.approve('admin', 'user', expiry, 100, now);
      vault.save('user', 'old-token');
      access.requestAccess('user', 'test@example.com', expiry);
      const reconnection = expiry + EXPIRED_TOKEN_RETENTION_MS;
      const consent = states.start('user', reconnection, true);
      const pending = states.consume(
        consent.state,
        consent.cookie.split(';')[0],
        'user',
        reconnection,
      )!;
      vault.saveIfPendingOrActive('user', 'new-token', reconnection, pending.generation);
      expect(deleteStaleGmailTokens(path, reconnection)).toBe(0);
      expect(vault.load('user')).toBe('new-token');
      expect(access.ownRequest('user')?.expiresAt).toBeNull();
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('preserves a token during and after failed revocation so disconnect can be retried', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-retention-revocation-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('user', 'test@example.com', now);
      const expiry = now + 1000;
      access.approve('admin', 'user', expiry, 100, now);
      vault.save('user', 'synthetic-refresh-token');
      const cleanupTime = expiry + EXPIRED_TOKEN_RETENTION_MS;
      expect(vault.beginDisconnect('user')).toBe('synthetic-refresh-token');
      expect(deleteStaleGmailTokens(path, cleanupTime)).toBe(0);
      vault.markRevocationFailed('user');
      expect(deleteStaleGmailTokens(path, cleanupTime)).toBe(0);
      expect(vault.beginDisconnect('user')).toBe('synthetic-refresh-token');
      expect(vault.finishDisconnect('user', 'synthetic-refresh-token')).toBe(true);
      expect(vault.has('user')).toBe(false);
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('keeps pending grants for seven days from consent and denied grants for seven days from denial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-pending-retention-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    try {
      access.bootstrapAdmin('admin');
      for (const user of ['pending', 'denied', 'approved']) {
        access.requestAccess(user, `${user}@example.com`, now);
        const grantTime = now + 1000;
        const start = states.start(user, grantTime, true);
        const pending = states.consume(start.state, start.cookie.split(';')[0], user, grantTime)!;
        vault.saveIfPendingOrActive(user, `${user}-token`, grantTime, pending.generation);
      }
      const denial = now + 2000;
      access.deny('admin', 'denied', denial);
      access.approve('admin', 'approved', now + EXPIRED_TOKEN_RETENTION_MS * 3, 100, now + 2000);
      expect(deleteStaleGmailTokens(path, now + 1000 + EXPIRED_TOKEN_RETENTION_MS - 1)).toBe(0);
      expect(deleteStaleGmailTokens(path, now + 1000 + EXPIRED_TOKEN_RETENTION_MS)).toBe(1);
      expect(vault.has('pending')).toBe(false);
      expect(vault.has('denied')).toBe(true);
      expect(vault.has('approved')).toBe(true);
      expect(deleteStaleGmailTokens(path, denial + EXPIRED_TOKEN_RETENTION_MS)).toBe(1);
      expect(vault.has('denied')).toBe(false);
      expect(vault.has('approved')).toBe(true);
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('gives legacy pending tokens a full retention window after migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-legacy-retention-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const db = new DatabaseSync(path);
    access.requestAccess('user', 'test@example.com', now - 30 * EXPIRED_TOKEN_RETENTION_MS);
    db.exec(`CREATE TABLE beta_gmail_tokens (subject TEXT PRIMARY KEY, version INTEGER NOT NULL,
      nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)`);
    db.prepare('INSERT INTO beta_gmail_tokens VALUES (?, 1, ?, ?, ?, 1)').run(
      'user',
      randomBytes(12),
      randomBytes(16),
      randomBytes(16),
    );
    db.close();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      expect(deleteStaleGmailTokens(path, now + EXPIRED_TOKEN_RETENTION_MS - 1)).toBe(0);
      expect(deleteStaleGmailTokens(path, now + EXPIRED_TOKEN_RETENTION_MS)).toBe(1);
    } finally {
      clock.mockRestore();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('requires an existing shared database and valid time', () => {
    expect(() => deleteStaleGmailTokens(':memory:', now)).toThrow('existing shared database');
    expect(() => deleteStaleGmailTokens('does-not-exist', now)).toThrow('existing shared database');
    expect(() => deleteStaleGmailTokens('does-not-exist', -1)).toThrow('timestamp');
  });
});
