import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
