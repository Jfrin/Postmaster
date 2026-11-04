import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BetaAccessStore, LeaseLostError } from '../src/beta/access.js';
import { createBetaStateWriteGuard } from '../src/beta/state-guard.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { State } from '../src/state.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const decision = {
  category: 'needs_review',
  confidence: 1,
  source: 'rule' as const,
  reason: 'synthetic',
};

describe('fenced per-user processing state', () => {
  it('fences every worker operation when the scheduler expires, even before takeover', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-leader-fence-'));
    const path = join(dir, 'beta.db');
    const first = new BetaAccessStore(path);
    const second = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = now;
    let state: State | undefined;
    try {
      first.bootstrapAdmin('admin');
      first.requestAccess('alice', 'alice@example.com', now);
      first.approve('admin', 'alice', now + 60_000, 100, now);
      vault.save('alice', 'synthetic');
      const leader = first.acquireScheduler('a'.repeat(32), now, 1000)!;
      first.startProcessing('alice', now);
      const worker = first.acquireLease('alice', 'b'.repeat(32), now, 5000, leader)!;
      state = new State(
        path,
        'alice',
        createBetaStateWriteGuard(worker, () => clock),
      );
      state.setCursor('before');
      expect(second.acquireScheduler('c'.repeat(32), now, 1000)).toBeNull();
      clock += 1000;
      expect(() => state!.setCursor('expired')).toThrow(LeaseLostError);
      expect(() => first.authorizeLeasedGmailAttempt(worker, clock, 'message_read')).toThrow(
        LeaseLostError,
      );
      expect(first.readUsage('admin', 'alice', clock).attempts).toBe(0);
      expect(first.renewLease(worker, clock, 5000)).toBe(false);
      expect(() => first.completeBacklogScan(worker, 7, clock)).toThrow(LeaseLostError);
      expect(() => first.recordCycle(worker, { seen: 1, processed: 1, failed: 0 }, clock)).toThrow(
        LeaseLostError,
      );
      expect(() => first.acquireLease('alice', 'd'.repeat(32), clock, 5000, leader)).toThrow(
        LeaseLostError,
      );
      const replacement = second.acquireScheduler('c'.repeat(32), clock, 5000)!;
      expect(replacement.fence).toBe(leader.fence + 1);
      expect(second.processingRequested('alice')).toBe(false);
      second.startProcessing('alice', clock);
      const current = second.acquireLease('alice', 'd'.repeat(32), clock, 5000, replacement)!;
      first.releaseScheduler(leader, clock);
      expect(second.processingRequested('alice')).toBe(true);
      expect(() => state!.setCursor('stale')).toThrow(LeaseLostError);
      const newState = new State(
        path,
        'alice',
        createBetaStateWriteGuard(current, () => clock),
      );
      try {
        newState.setCursor('current');
        expect(newState.getCursor()).toBe('current');
      } finally {
        newState.close();
      }
      second.releaseScheduler(replacement, clock);
      expect(second.processingRequested('alice')).toBe(false);
    } finally {
      state?.close();
      vault.close();
      second.close();
      first.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects stale, stopped and wrong-user writes inside the database transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-state-fence-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = now;
    let alice: State | undefined;
    let wrong: State | undefined;
    let bob: State | undefined;
    try {
      access.bootstrapAdmin('admin');
      for (const subject of ['alice', 'bob']) {
        access.requestAccess(subject, `${subject}@example.com`, now);
        access.approve('admin', subject, now + 10_000, 100, now);
        vault.save(subject, 'synthetic-token');
        access.startProcessing(subject, now);
      }
      const aliceLease = access.acquireLease('alice', 'a'.repeat(32), now, 1000)!;
      const bobLease = access.acquireLease('bob', 'b'.repeat(32), now, 1000)!;
      alice = new State(
        path,
        'alice',
        createBetaStateWriteGuard(aliceLease, () => clock),
      );
      bob = new State(
        path,
        'bob',
        createBetaStateWriteGuard(bobLease, () => clock),
      );
      wrong = new State(
        path,
        'bob',
        createBetaStateWriteGuard(aliceLease, () => clock),
      );
      alice.setCursor('alice-cursor');
      alice.recordDecision('same-id', decision, true, new Date(now));
      alice.observeSender('synthetic@example.com', 'needs_review', 1);
      alice.countLlmCall(new Date(now));
      expect(bob.getCursor()).toBeNull();
      expect(bob.hasDecision('same-id')).toBe(false);
      expect(bob.llmCallsToday(new Date(now))).toBe(0);
      expect(() => wrong!.setCursor('wrong')).toThrow(LeaseLostError);
      clock = now + 1000;
      expect(() => alice!.setCursor('stale')).toThrow(LeaseLostError);
      expect(() => alice!.recordDecision('other', decision, true, new Date(now))).toThrow(
        LeaseLostError,
      );
      expect(() => alice!.observeSender('synthetic@example.com', 'needs_review', 0)).toThrow(
        LeaseLostError,
      );
      expect(() => alice!.countLlmCall(new Date(now))).toThrow(LeaseLostError);
      expect(alice.getCursor()).toBe('alice-cursor');
      expect(alice.hasDecision('other')).toBe(false);
      expect(alice.llmCallsToday(new Date(now))).toBe(1);
      const replacement = access.acquireLease('alice', 'c'.repeat(32), clock, 1000)!;
      const current = new State(
        path,
        'alice',
        createBetaStateWriteGuard(replacement, () => clock),
      );
      try {
        current.setCursor('new-cursor');
        access.stopProcessing('alice');
        expect(() => current.setCursor('after-stop')).toThrow(LeaseLostError);
        expect(current.getCursor()).toBe('new-cursor');
      } finally {
        current.close();
      }
    } finally {
      wrong?.close();
      bob?.close();
      alice?.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
