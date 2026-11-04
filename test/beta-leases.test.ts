import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  BetaAccessStore,
  DailyReadLimitError,
  LeaseLostError,
} from '../src/beta/access.js';
import { createLeasedBetaGmailGuard } from '../src/beta/gmail-guard.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const ownerA = 'a'.repeat(32);
const ownerB = 'b'.repeat(32);

describe('per-user worker lease foundation', () => {
  it('fences a stale worker and preserves per-user read quotas across connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-leases-'));
    const path = join(dir, 'beta.db');
    const first = new BetaAccessStore(path);
    const second = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      first.bootstrapAdmin('admin');
      first.requestAccess('alice', 'alice@example.com', now);
      first.approve('admin', 'alice', now + 60_000, 2, now);
      vault.save('alice', 'synthetic-refresh-token');
      expect(() => first.acquireLease('alice', ownerA, now, 1000)).toThrow(AccessDeniedError);
      first.startProcessing('alice', now);
      const old = first.acquireLease('alice', ownerA, now, 1000)!;
      expect(old.fence).toBe(1);
      expect(second.acquireLease('alice', ownerB, now, 1000)).toBeNull();
      let clock = now;
      const oldGuard = createLeasedBetaGmailGuard(first, old, () => clock);
      oldGuard('message_read');
      clock = now + 1000;
      const current = second.acquireLease('alice', ownerB, clock, 1000)!;
      expect(current.fence).toBe(2);
      expect(() => oldGuard('other')).toThrow(LeaseLostError);
      expect(() => first.recordCycle(old, { seen: 1, processed: 1, failed: 0 }, clock)).toThrow(
        LeaseLostError,
      );
      expect(first.renewLease(old, clock, 1000)).toBe(false);
      first.releaseLease(old);
      const currentGuard = createLeasedBetaGmailGuard(second, current, () => clock);
      currentGuard('message_read');
      expect(() => currentGuard('message_read')).toThrow(DailyReadLimitError);
      expect(first.readUsage('admin', 'alice', now).attempts).toBe(2);
      expect(second.renewLease(current, clock, 1000)).toBe(true);
      second.releaseLease(current);
      expect(second.acquireLease('alice', ownerA, clock, 1000)?.fence).toBe(3);
    } finally {
      vault.close();
      second.close();
      first.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('does not renew or allow calls after expiry, denial or disconnect, and isolates users', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-leases-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.bootstrapAdmin('admin');
      for (const subject of ['alice', 'bob']) {
        access.requestAccess(subject, `${subject}@example.com`, now);
        access.approve('admin', subject, now + 5000, 100, now);
        vault.save(subject, 'synthetic-token');
        access.startProcessing(subject, now);
      }
      const alice = access.acquireLease('alice', ownerA, now, 2000)!;
      const bob = access.acquireLease('bob', ownerA, now, 2000)!;
      expect(access.renewLease(alice, now + 1000, 2000)).toBe(true);
      vault.disableAndLoad('alice');
      expect(access.renewLease(alice, now + 1001, 2000)).toBe(false);
      expect(() => access.authorizeLeasedGmailAttempt(alice, now + 1001, 'other')).toThrow(
        AccessDeniedError,
      );
      expect(() => access.authorizeLeasedGmailAttempt(bob, now + 2000, 'other')).toThrow(
        LeaseLostError,
      );
      expect(access.renewLease(bob, now + 2000, 2000)).toBe(false);
      expect(() => access.acquireLease('bob', ownerB, now + 5000, 1000)).toThrow(AccessDeniedError);
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('requires a valid owner, bounded duration, approval, and an enabled connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-leases-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      expect(() => access.acquireLease('alice', ownerA, now, 1000)).toThrow(AccessDeniedError);
      access.approve('admin', 'alice', now + 10_000, 100, now);
      expect(() => access.acquireLease('alice', ownerA, now, 1000)).toThrow(AccessDeniedError);
      vault.save('alice', 'synthetic-token');
      expect(() => access.acquireLease('alice', 'short', now, 1000)).toThrow();
      expect(() => access.acquireLease('alice', ownerA, now, 999)).toThrow();
      expect(() => access.acquireLease('alice', ownerA, now, 300_001)).toThrow();
      access.startProcessing('alice', now);
      expect(access.acquireLease('alice', ownerA, now, 1000)).not.toBeNull();
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('requires a fresh Start after denial, reapproval, disconnect, or scheduler restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-leases-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 10_000, 100, now);
      vault.save('alice', 'synthetic-token');
      access.startProcessing('alice', now);
      const lease = access.acquireLease('alice', ownerA, now, 1000)!;
      expect(access.needsBacklogScan(lease, 7, now)).toBe(true);
      access.completeBacklogScan(lease, 7, now);
      expect(access.needsBacklogScan(lease, 7, now)).toBe(false);
      expect(access.needsBacklogScan(lease, 3, now)).toBe(true);
      access.deny('admin', 'alice', now + 1);
      access.approve('admin', 'alice', now + 10_000, 100, now + 2);
      expect(access.processingRequested('alice')).toBe(false);
      expect(() => access.authorizeLeasedGmailAttempt(lease, now + 2, 'other')).toThrow(
        AccessDeniedError,
      );
      access.startProcessing('alice', now + 2);
      const second = access.acquireLease('alice', ownerB, now + 2, 1000)!;
      expect(second.fence).toBe(2);
      expect(access.needsBacklogScan(second, 7, now + 2)).toBe(true);
      expect(access.acquireScheduler(ownerA, now + 3, 1000)).not.toBeNull();
      expect(access.processingRequested('alice')).toBe(false);
      expect(() => access.acquireLease('alice', ownerA, now + 3, 1000)).toThrow(AccessDeniedError);
      access.startProcessing('alice', now + 3);
      access.stopProcessing('alice');
      expect(access.processingRequested('alice')).toBe(false);
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
