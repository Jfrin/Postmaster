import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { BetaScheduler } from '../src/beta/scheduler.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const stats = { seen: 1, processed: 1, failed: 0 };

describe('single-instance beta scheduler prototype', () => {
  it('runs maintenance on the leader and blocks new work until failed maintenance succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-scheduler-maintenance-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = now;
    const runner = { run: vi.fn().mockResolvedValue({ status: 'busy' }) };
    const maintenance = vi.fn().mockImplementationOnce(() => {
      throw new Error('synthetic maintenance failure');
    });
    const scheduler = new BetaScheduler(access, runner, () => clock, 1, 60_000, maintenance);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 8_000_000, 100, now);
      vault.save('alice', 'synthetic');
      scheduler.start();
      access.startProcessing('alice', now);
      await expect(scheduler.tick()).rejects.toThrow('synthetic maintenance failure');
      expect(scheduler.status().schedulerError).toBe(true);
      expect(runner.run).not.toHaveBeenCalled();
      await scheduler.tick();
      expect(maintenance).toHaveBeenCalledTimes(2);
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(scheduler.status().schedulerError).toBe(false);
      clock += 10_000;
      await scheduler.tick();
      expect(maintenance).toHaveBeenCalledTimes(2);
      for (let n = 0; n < 180; n++) {
        clock += 20_000;
        await scheduler.tick();
      }
      expect(scheduler.status().online).toBe(true);
      expect(maintenance).toHaveBeenCalledTimes(3);
    } finally {
      await scheduler.stop();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('renews while a cycle is in flight and goes offline when renewal fails', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-scheduler-heartbeat-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const other = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = now;
    let finish!: (value: { status: 'busy' }) => void;
    const runner = {
      run: vi.fn().mockReturnValue(
        new Promise<{ status: 'busy' }>((resolve) => {
          finish = resolve;
        }),
      ),
    };
    const scheduler = new BetaScheduler(access, runner, () => clock, 1, 60_000);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 120_000, 100, now);
      vault.save('alice', 'synthetic');
      scheduler.start();
      access.startProcessing('alice', now);
      const cycle = scheduler.tick();
      await Promise.resolve();
      for (let n = 0; n < 4; n++) {
        clock += 10_000;
        vi.advanceTimersByTime(10_000);
      }
      expect(scheduler.status().online).toBe(true);
      expect(other.acquireScheduler('z'.repeat(32), clock, 1000)).toBeNull();
      vi.spyOn(access, 'renewScheduler').mockImplementation(() => {
        throw new Error('database unavailable');
      });
      clock += 10_000;
      vi.advanceTimersByTime(10_000);
      expect(scheduler.status()).toMatchObject({ online: false, schedulerError: true });
      const stopping = scheduler.stop();
      finish({ status: 'busy' });
      await cycle;
      await stopping;
    } finally {
      await scheduler.stop();
      vault.close();
      other.close();
      access.close();
      rmSync(dir, { recursive: true });
      vi.useRealTimers();
    }
  });

  it('rejects a second scheduler and safely handles takeover after lease loss', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-scheduler-takeover-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const other = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = now;
    const runner = {
      run: vi.fn().mockResolvedValue({
        status: 'completed',
        stats,
        pollIntervalSeconds: 300,
        limitReached: false,
      }),
    };
    const first = new BetaScheduler(access, runner, () => clock);
    const second = new BetaScheduler(other, runner, () => clock);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 120_000, 100, now);
      vault.save('alice', 'synthetic');
      first.start();
      access.startProcessing('alice', now);
      expect(() => second.start()).toThrow('lease unavailable');
      expect(access.processingRequested('alice')).toBe(true);
      await first.tick();
      expect(runner.run).toHaveBeenCalledTimes(1);
      clock += 30_000;
      second.start();
      expect(other.processingRequested('alice')).toBe(false);
      other.startProcessing('alice', clock);
      expect(first.status()).toMatchObject({ online: false, schedulerError: true });
      await first.tick();
      await first.stop();
      expect(other.processingRequested('alice')).toBe(true);
      await second.tick();
      expect(runner.run).toHaveBeenCalledTimes(2);
      expect(runner.run).toHaveBeenLastCalledWith('alice', expect.objectContaining({ fence: 2 }));
      await second.stop();
      expect(other.processingRequested('alice')).toBe(false);
    } finally {
      await first.stop();
      await second.stop();
      vault.close();
      other.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('starts stopped, schedules users fairly, and notices a fresh Start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-scheduler-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = now;
    const runner = {
      run: vi.fn().mockResolvedValue({
        status: 'completed',
        stats,
        pollIntervalSeconds: 300,
        limitReached: false,
      }),
    };
    const scheduler = new BetaScheduler(access, runner, () => clock, 1, 60_000);
    try {
      access.bootstrapAdmin('admin');
      for (const subject of ['alice', 'bob']) {
        access.requestAccess(subject, `${subject}@example.com`, now);
        access.approve('admin', subject, now + 86_400_000, 100, now);
        vault.save(subject, 'synthetic-token');
        access.startProcessing(subject, now);
      }
      scheduler.start();
      expect(access.processingRequested('alice')).toBe(false);
      expect(access.processingRequested('bob')).toBe(false);
      access.startProcessing('alice', now);
      access.startProcessing('bob', now);
      await scheduler.tick();
      await scheduler.tick();
      expect(runner.run.mock.calls.map((call: unknown[]) => call[0])).toEqual(['alice', 'bob']);
      clock += 1000;
      await scheduler.tick();
      expect(runner.run).toHaveBeenCalledTimes(2);
      access.stopProcessing('alice');
      access.startProcessing('alice', clock);
      await scheduler.tick();
      expect(runner.run).toHaveBeenCalledTimes(3);
      expect(runner.run).toHaveBeenLastCalledWith('alice', expect.objectContaining({ fence: 1 }));
      await scheduler.stop();
      expect(scheduler.status().online).toBe(false);
      expect(access.processingRequested('alice')).toBe(false);
      expect(access.processingRequested('bob')).toBe(false);
    } finally {
      await scheduler.stop();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('waits until UTC midnight after a read limit and skips expired or disconnected users', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-scheduler-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let clock = Date.parse('2026-11-04T23:59:58Z');
    const runner = {
      run: vi.fn().mockResolvedValue({
        status: 'completed',
        stats,
        pollIntervalSeconds: 300,
        limitReached: true,
      }),
    };
    const scheduler = new BetaScheduler(access, runner, () => clock, 1, 60_000);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 3 * 86_400_000, 1, now);
      vault.save('alice', 'synthetic-token');
      scheduler.start();
      access.startProcessing('alice', now);
      await scheduler.tick();
      clock = Date.parse('2026-11-04T23:59:59Z');
      await scheduler.tick();
      expect(runner.run).toHaveBeenCalledTimes(1);
      clock = Date.parse('2026-11-05T00:00:00Z');
      await scheduler.tick();
      expect(runner.run).toHaveBeenCalledTimes(2);
      vault.disableAndLoad('alice');
      clock += 1000;
      await scheduler.tick();
      expect(runner.run).toHaveBeenCalledTimes(2);
    } finally {
      await scheduler.stop();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('does not launch overlapping cycles for one user and waits for in-flight work on Stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-scheduler-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    let finish!: (value: {
      status: 'completed';
      stats: typeof stats;
      pollIntervalSeconds: number;
      limitReached: boolean;
    }) => void;
    const pending = new Promise<{
      status: 'completed';
      stats: typeof stats;
      pollIntervalSeconds: number;
      limitReached: boolean;
    }>((resolve) => {
      finish = resolve;
    });
    const runner = { run: vi.fn().mockReturnValue(pending) };
    const scheduler = new BetaScheduler(access, runner, () => now, 1, 60_000);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 60_000, 100, now);
      vault.save('alice', 'synthetic-token');
      scheduler.start();
      access.startProcessing('alice', now);
      const first = scheduler.tick();
      await Promise.resolve();
      await scheduler.tick();
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(scheduler.status().runningCycles).toBe(1);
      const stopped = scheduler.stop();
      expect(access.processingRequested('alice')).toBe(false);
      expect(() => scheduler.start()).toThrow('stopping');
      expect(scheduler.stop()).toBe(stopped);
      finish({ status: 'completed', stats, pollIntervalSeconds: 300, limitReached: false });
      await first;
      await stopped;
      expect(scheduler.status().runningCycles).toBe(0);
    } finally {
      await scheduler.stop();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
