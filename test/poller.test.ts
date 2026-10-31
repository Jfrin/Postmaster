import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GmailQuotaError } from '../src/gmail-quota.js';
import { readControl, readStatus, writeControl } from '../src/control.js';
import { silentLogger } from '../src/logger.js';
import { runPoller, type PollerOptions } from '../src/poller.js';
import { State } from '../src/state.js';
import { FakeClassifier, FakeMail, makeConfig, makeMessage } from './helpers.js';

/** Runs the poller with a fake clock: `script[n]` runs right after the n-th sleep. */
function harness(opts: {
  script?: Record<number, () => void>;
  limit: number;
  mail?: FakeMail;
  makeMail?: () => FakeMail;
  poll?: number;
}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pm-poll-'));
  const mail = opts.mail ?? new FakeMail();
  const state = new State(':memory:');
  let ticks = 0;
  let mailBuilt = 0;
  const config = makeConfig((c) => (c.settings.poll_interval_seconds = opts.poll ?? 3));
  const options: PollerOptions = {
    dataDir,
    reloadConfig: () => config,
    state,
    makeMail: opts.makeMail ?? (() => (mailBuilt++, mail)),
    makeClassifier: () =>
      new FakeClassifier({ category: 'receipts', confidence: 0.95, reason: 'x' }),
    log: silentLogger,
    sleep: () => {
      ticks++;
      opts.script?.[ticks]?.();
      return Promise.resolve();
    },
    exiting: () => ticks >= opts.limit,
  };
  return { dataDir, mail, state, options, built: () => mailBuilt };
}

describe('runPoller', () => {
  it('waits out Gmail quota cooldown even when the poll interval is shorter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const h = harness({ limit: 62, poll: 1 });
      const scans: number[] = [];
      h.mail.listNew = () => {
        scans.push(Date.now());
        if (scans.length === 1) {
          return Promise.reject(new GmailQuotaError(Date.now() + 60_000, new Error('quota')));
        }
        return Promise.resolve({ ids: [], cursor: '100' });
      };
      let slept = 0;
      h.options.sleep = () => {
        slept++;
        vi.setSystemTime(slept * 1000);
        if (slept === 1) writeControl(h.dataDir, true);
        return Promise.resolve();
      };
      h.options.exiting = () => slept >= 62;
      await runPoller(h.options);
      expect(scans).toEqual([1000, 61_000]);
      expect(readStatus(h.dataDir)?.lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays idle and touches nothing until Start is pressed', async () => {
    const h = harness({ limit: 5 });
    h.mail.add(makeMessage());
    await runPoller(h.options);
    expect(h.built()).toBe(0); // Gmail client never even built
    expect(h.mail.modifies).toHaveLength(0);
    expect(readStatus(h.dataDir)?.state).toBe('stopped');
  });

  it('always boots stopped, even if the control file says running', async () => {
    const h = harness({ limit: 0 });
    writeControl(h.dataDir, true);
    await runPoller(h.options);
    expect(readControl(h.dataDir).running).toBe(false);
  });

  it('runs a cycle after Start and stops cleanly after Stop', async () => {
    const h = harness({ limit: 12, poll: 100 });
    h.mail.add(makeMessage());
    let slept = 0;
    h.options.sleep = () => {
      slept++;
      if (slept === 2) writeControl(h.dataDir, true);
      if (slept === 6) writeControl(h.dataDir, false);
      return Promise.resolve();
    };
    h.options.exiting = () => slept >= 12;
    await runPoller(h.options);
    expect(h.mail.modifies).toHaveLength(1);
    const status = readStatus(h.dataDir);
    expect(status?.lastCycle).toMatchObject({ seen: 1, processed: 1, failed: 0, dryRun: false });
    expect(status?.state).toBe('stopped');
  });

  it('reports a missing token in the status and stays stopped instead of crashing', async () => {
    const h = harness({
      limit: 4,
      makeMail: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT', path: 'secrets/token.json' });
      },
    });
    let slept = 0;
    h.options.sleep = () => {
      if (++slept === 1) writeControl(h.dataDir, true);
      return Promise.resolve();
    };
    h.options.exiting = () => slept >= 4;
    await runPoller(h.options);
    expect(readControl(h.dataDir).running).toBe(false);
    expect(readStatus(h.dataDir)?.lastError).toMatch(/token\.json.*auth/s);
  });

  it('rescans on Start and lookback changes, then uses history without reprocessing old decisions', async () => {
    const h = harness({ limit: 6, poll: 1 });
    const config = h.options.reloadConfig();
    const initialDays = config.settings.backlog_days;
    h.state.setCursor('old-cursor');
    h.mail.add(makeMessage({ id: 'old-inbox-mail' }));
    const scans: { cursor: string | null; days: number }[] = [];
    h.mail.listNew = (cursor, days) => {
      scans.push({ cursor, days });
      return Promise.resolve({
        ids: cursor ? [] : [...h.mail.messages.keys()],
        cursor: 'new-cursor',
      });
    };
    let slept = 0;
    h.options.sleep = () => {
      slept++;
      if (slept === 1 || slept === 5) writeControl(h.dataDir, true);
      if (slept === 2) {
        config.settings.backlog_days = 400;
        h.mail.add(makeMessage({ id: 'older-inbox-mail' }));
      }
      if (slept === 4) writeControl(h.dataDir, false);
      return Promise.resolve();
    };
    h.options.exiting = () => slept >= 6;
    await runPoller(h.options);
    expect(scans).toEqual([
      { cursor: null, days: initialDays },
      { cursor: null, days: 400 },
      { cursor: 'new-cursor', days: 400 },
      { cursor: null, days: 400 },
    ]);
    expect(h.mail.modifies.map((m) => m.id)).toEqual(['old-inbox-mail', 'older-inbox-mail']);
    expect(h.state.getCursor()).toBe('new-cursor');
  });

  it('retries a failed backlog scan even when a saved history cursor exists', async () => {
    const h = harness({ limit: 4, poll: 1 });
    h.state.setCursor('old-cursor');
    h.mail.add(makeMessage());
    const cursors: (string | null)[] = [];
    h.mail.listNew = (cursor) => {
      cursors.push(cursor);
      return Promise.resolve({ ids: cursor ? [] : ['m1'], cursor: 'new-cursor' });
    };
    const fetchMessage = h.mail.fetchMessage.bind(h.mail);
    let attempts = 0;
    h.mail.fetchMessage = (id) => {
      if (++attempts === 1) return Promise.reject(new Error('temporary fetch failure'));
      return fetchMessage(id);
    };
    let slept = 0;
    h.options.sleep = () => {
      if (++slept === 1) writeControl(h.dataDir, true);
      return Promise.resolve();
    };
    h.options.exiting = () => slept >= 4;
    await runPoller(h.options);
    expect(cursors).toEqual([null, null, 'new-cursor']);
    expect(h.mail.modifies).toHaveLength(1);
    expect(h.state.getCursor()).toBe('new-cursor');
  });

  it('Stop mid-cycle finishes the current email, then holds the cursor', async () => {
    const h = harness({ limit: 6 });
    h.mail.add(makeMessage({ id: 'a' }));
    h.mail.add(makeMessage({ id: 'b', from: 'x@y.com' }));
    const fetchOne = h.mail.fetchMessage.bind(h.mail);
    h.mail.fetchMessage = (id: string) => {
      if (id === 'a') writeControl(h.dataDir, false); // user presses Stop during the first email
      return fetchOne(id);
    };
    let slept = 0;
    h.options.sleep = () => {
      slept++;
      if (slept === 1) writeControl(h.dataDir, true);
      return Promise.resolve();
    };
    h.options.exiting = () => slept >= 3;
    await runPoller(h.options);
    expect(h.mail.modifies.map((m) => m.id)).toEqual(['a']);
    expect(h.state.getCursor()).toBeNull();
    expect(readStatus(h.dataDir)?.lastCycle?.stopped).toBe(true);
  });
});
