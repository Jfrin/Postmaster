import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it, vi } from 'vitest';
import { MockClassifier } from '../src/classifier.js';
import { State } from '../src/state.js';
import { AccessDeniedError, BetaAccessStore } from '../src/beta/access.js';
import { guardBetaClock } from '../src/beta/clock.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { BetaProcessingEvents } from '../src/beta/processing-events.js';
import { BetaCycleRunner, type GmailServiceFactory } from '../src/beta/worker.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const defaults = readFileSync('config/categories.default.yaml', 'utf8');

function fakeService(ids: string[]) {
  const list = vi.fn().mockResolvedValue({ data: { messages: ids.map((id) => ({ id })) } });
  const history = vi.fn().mockResolvedValue({ data: { history: [] } });
  const get = vi.fn().mockImplementation(async ({ id }: { id: string }) => ({
    data: {
      threadId: id,
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'orders@example.com' },
          { name: 'Subject', value: 'Synthetic order shipped' },
        ],
        body: { data: Buffer.from('Your synthetic order shipped.').toString('base64url') },
      },
    },
  }));
  const modify = vi.fn().mockResolvedValue({ data: {} });
  const service = {
    users: {
      getProfile: vi.fn().mockResolvedValue({ data: { historyId: '100' } }),
      labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
      history: { list: history },
      messages: { list, get, modify },
    },
  } as unknown as gmail_v1.Gmail;
  return { service, list, history, get, modify };
}

describe('fenced beta processing cycle prototype', () => {
  it('does not issue another Gmail request after observing a clock rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-worker-clock-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    const mail = fakeService(['one', 'two']);
    let clock = now;
    const checked = guardBetaClock(() => clock);
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = mail.get.getMockImplementation()!;
    mail.get.mockImplementation(async (arg: { id: string }) => {
      started();
      await resume;
      return original(arg);
    });
    const runner = new BetaCycleRunner({
      databasePath: path,
      vaultKey: key,
      defaultConfigYaml: defaults,
      makeGmailService: () => ({ service: mail.service }),
      classifier: new MockClassifier(),
      now: () => new Date(checked()),
    });
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 60_000, 100, now);
      vault.save('alice', 'synthetic-token');
      const scheduler = access.acquireScheduler('s'.repeat(32), now, 30_000)!;
      access.startProcessing('alice', now);
      const cycle = runner.run('alice', scheduler);
      await inFlight;
      clock--;
      expect(checked).toThrow('beta clock is unavailable');
      release();
      await expect(cycle).rejects.toThrow('beta clock is unavailable');
      expect(mail.get).toHaveBeenCalledTimes(1);
      expect(mail.modify).not.toHaveBeenCalled();
      const state = new State(path, 'alice');
      try {
        expect(state.hasDecision('one')).toBe(false);
        expect(state.getCursor()).toBeNull();
      } finally {
        state.close();
      }
    } finally {
      release();
      runner.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('keeps two users and their Gmail tokens, state, cursors and decisions separate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-worker-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    const aliceMail = fakeService(['same-id']);
    const bobMail = fakeService(['same-id']);
    const factory: GmailServiceFactory = (subject, token) => {
      expect(token).toBe(`synthetic-${subject}-token`);
      return { service: subject === 'alice' ? aliceMail.service : bobMail.service };
    };
    const runner = new BetaCycleRunner({
      databasePath: path,
      vaultKey: key,
      defaultConfigYaml: defaults,
      makeGmailService: factory,
      classifier: new MockClassifier(),
      now: () => new Date(now),
    });
    try {
      access.bootstrapAdmin('admin');
      for (const subject of ['alice', 'bob']) {
        access.requestAccess(subject, `${subject}@example.com`, now);
        access.approve('admin', subject, now + 60_000, 100, now);
        vault.save(subject, `synthetic-${subject}-token`);
      }
      await expect(runner.run('alice')).rejects.toThrow(AccessDeniedError);
      access.startProcessing('alice', now);
      access.startProcessing('bob', now);
      const [alice, bob] = await Promise.all([runner.run('alice'), runner.run('bob')]);
      expect(alice).toMatchObject({ status: 'completed', stats: { processed: 1, failed: 0 } });
      expect(bob).toMatchObject({ status: 'completed', stats: { processed: 1, failed: 0 } });
      const aliceState = new State(path, 'alice');
      const bobState = new State(path, 'bob');
      try {
        expect(aliceState.hasDecision('same-id')).toBe(true);
        expect(bobState.hasDecision('same-id')).toBe(true);
        expect(aliceState.getCursor()).toBe('100');
        expect(bobState.getCursor()).toBe('100');
      } finally {
        aliceState.close();
        bobState.close();
      }
      expect(aliceMail.modify).not.toHaveBeenCalled();
      expect(bobMail.modify).not.toHaveBeenCalled();
      expect(access.metrics('admin', now).readsToday).toBe(2);
      expect(access.metrics('admin', now)).toMatchObject({
        cyclesToday: 2,
        processedToday: 2,
        failedToday: 0,
      });
      expect(access.cycleUsage('admin', 'alice', now)).toMatchObject({ cycles: 1, processed: 1 });
      await runner.run('alice');
      expect(aliceMail.list).toHaveBeenCalledTimes(1);
      expect(aliceMail.history).toHaveBeenCalledTimes(1);
      expect(bobMail.history).not.toHaveBeenCalled();
    } finally {
      runner.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('holds the cursor when the daily read cap is reached and resumes after reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-worker-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    const mail = fakeService(['one', 'two']);
    const events = new BetaProcessingEvents(path);
    let clock = now;
    const runner = new BetaCycleRunner({
      databasePath: path,
      vaultKey: key,
      defaultConfigYaml: defaults,
      makeGmailService: () => ({ service: mail.service }),
      classifier: new MockClassifier(),
      now: () => new Date(clock),
    });
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 3 * 86_400_000, 1, now);
      vault.save('alice', 'synthetic-token');
      access.startProcessing('alice', now);
      const first = await runner.run('alice');
      expect(first).toMatchObject({ status: 'completed', stats: { processed: 1, stopped: true } });
      expect(
        events.recent('alice', now).map((event) => (event as { event: string }).event),
      ).not.toContain('backlog_completed');
      const state = new State(path, 'alice');
      try {
        expect(state.getCursor()).toBeNull();
        expect(state.hasDecision('one')).toBe(true);
        expect(state.hasDecision('two')).toBe(false);
        clock = now + 86_400_000;
        const second = await runner.run('alice');
        expect(second).toMatchObject({ status: 'completed', stats: { processed: 1, failed: 0 } });
        expect(
          events.recent('alice', clock).map((event) => (event as { event: string }).event),
        ).toContain('backlog_completed');
        expect(state.getCursor()).toBe('100');
        expect(state.hasDecision('two')).toBe(true);
      } finally {
        state.close();
      }
      expect(mail.get).toHaveBeenCalledTimes(2);
    } finally {
      events.close();
      runner.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it.each(['stop', 'scheduler expiry'] as const)(
    'prevents state writes after %s even when a Gmail read was already in flight',
    async (reason) => {
      const dir = mkdtempSync(join(tmpdir(), 'postmaster-worker-'));
      const path = join(dir, 'beta.db');
      const key = randomBytes(32);
      const access = new BetaAccessStore(path);
      const vault = new GmailTokenVault(path, key);
      const mail = fakeService(['one']);
      let clock = now;
      let release!: () => void;
      let started!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        started = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = mail.get.getMockImplementation()!;
      mail.get.mockImplementation(async (arg: { id: string }) => {
        started();
        await resume;
        return original(arg);
      });
      const runner = new BetaCycleRunner({
        databasePath: path,
        vaultKey: key,
        defaultConfigYaml: defaults,
        makeGmailService: () => ({ service: mail.service }),
        classifier: new MockClassifier(),
        now: () => new Date(clock),
      });
      try {
        access.bootstrapAdmin('admin');
        access.requestAccess('alice', 'alice@example.com', now);
        access.approve('admin', 'alice', now + 60_000, 100, now);
        vault.save('alice', 'synthetic-token');
        const scheduler = access.acquireScheduler('s'.repeat(32), now, 1000)!;
        access.startProcessing('alice', now);
        const cycle = runner.run('alice', scheduler);
        await inFlight;
        if (reason === 'stop') access.stopProcessing('alice');
        else clock += 1000;
        release();
        const result = await cycle;
        expect(result).toMatchObject({ status: 'completed', stats: { failed: 1 } });
        const state = new State(path, 'alice');
        try {
          expect(state.hasDecision('one')).toBe(false);
          expect(state.getCursor()).toBeNull();
        } finally {
          state.close();
        }
        expect(mail.modify).not.toHaveBeenCalled();
      } finally {
        runner.close();
        vault.close();
        access.close();
        rmSync(dir, { recursive: true });
      }
    },
  );
});
