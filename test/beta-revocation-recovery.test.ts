import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessDeniedError, BetaAccessStore } from '../src/beta/access.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import {
  recoverRevocationOffline,
  REVOCATION_RECOVERY_CONFIRMATION,
} from '../src/beta/revocation-recovery.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');

describe('offline revocation recovery', () => {
  it('requires an operator confirmation and stopped scheduler, fences callbacks, and isolates users', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-revoke-recovery-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    try {
      access.requestAccess('alice', 'alice@example.com', now);
      access.requestAccess('bob', 'bob@example.com', now);
      vault.save('alice', 'alice-token', now);
      vault.save('bob', 'bob-token', now);
      const start = states.start('alice', now, true);
      expect(vault.beginDisconnect('alice')).toBe('alice-token');
      const lease = access.acquireScheduler('z'.repeat(32), now, 30_000)!;
      expect(() => recoverRevocationOffline(path, 'alice', '', now)).toThrow('confirmation');
      expect(() =>
        recoverRevocationOffline(path, 'alice', REVOCATION_RECOVERY_CONFIRMATION, now),
      ).toThrow('stop all beta instances');
      expect(vault.has('alice')).toBe(true);
      access.releaseScheduler(lease, now);
      recoverRevocationOffline(path, 'alice', REVOCATION_RECOVERY_CONFIRMATION, now);
      expect(vault.has('alice')).toBe(false);
      expect(vault.load('bob')).toBe('bob-token');
      expect(access.processingRequested('alice')).toBe(false);
      const pending = states.consume(start.state, start.cookie.split(';')[0], 'alice', now)!;
      expect(() => vault.saveIfPendingOrActive('alice', 'stale', now, pending.generation)).toThrow(
        AccessDeniedError,
      );
      expect(() => states.start('alice', now, true)).not.toThrow();
      expect(() =>
        recoverRevocationOffline(path, 'alice', REVOCATION_RECOVERY_CONFIRMATION, now),
      ).toThrow('no interrupted or failed revocation');
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('does not delete a re-enabled connection even if an old revocation fence exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-revoke-recovery-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.requestAccess('alice', 'alice@example.com', now);
      vault.save('alice', 'old', now);
      vault.beginDisconnect('alice');
      vault.markRevocationFailed('alice');
      vault.save('alice', 'replacement', now + 1);
      expect(() =>
        recoverRevocationOffline(path, 'alice', REVOCATION_RECOVERY_CONFIRMATION, now + 1),
      ).toThrow('enabled connection');
      expect(vault.load('alice')).toBe('replacement');
      expect(() => recoverRevocationOffline(':memory:', 'alice', '', now)).toThrow('confirmation');
      expect(() =>
        recoverRevocationOffline('missing.db', 'alice', REVOCATION_RECOVERY_CONFIRMATION, now),
      ).toThrow('existing shared database');
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
