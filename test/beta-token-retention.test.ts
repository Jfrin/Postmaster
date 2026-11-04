import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import {
  deleteExpiredGmailTokens,
  EXPIRED_TOKEN_RETENTION_MS,
} from '../src/beta/token-retention.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');

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
      expect(deleteExpiredGmailTokens(path, expiry + EXPIRED_TOKEN_RETENTION_MS - 1)).toBe(0);
      expect(vault.load('user')).toBe('synthetic-refresh-token');
      expect(deleteExpiredGmailTokens(path, expiry + EXPIRED_TOKEN_RETENTION_MS)).toBe(1);
      expect(vault.load('user')).toBeNull();
      expect(deleteExpiredGmailTokens(path, expiry + EXPIRED_TOKEN_RETENTION_MS)).toBe(0);
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
      expect(deleteExpiredGmailTokens(path, reapproval + 1)).toBe(0);
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
      expect(deleteExpiredGmailTokens(path, reconnection)).toBe(0);
      expect(vault.load('user')).toBe('new-token');
      expect(access.ownRequest('user')?.expiresAt).toBeNull();
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('requires an existing shared database and valid time', () => {
    expect(() => deleteExpiredGmailTokens(':memory:', now)).toThrow('existing shared database');
    expect(() => deleteExpiredGmailTokens('does-not-exist', now)).toThrow(
      'existing shared database',
    );
    expect(() => deleteExpiredGmailTokens('does-not-exist', -1)).toThrow('timestamp');
  });
});
