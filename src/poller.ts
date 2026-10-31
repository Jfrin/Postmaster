import type { Classifier } from './classifier.js';
import type { Config } from './config.js';
import { GmailQuotaError } from './gmail-quota.js';
import { readControl, touchHeartbeat, writeControl, writeStatus, type Status } from './control.js';
import type { Logger } from './logger.js';
import { runCycle } from './pipeline.js';
import type { State } from './state.js';
import type { MailClient } from './types.js';

export interface PollerOptions {
  dataDir: string;
  reloadConfig: () => Config;
  state: State;
  /** Built lazily on first Start, so a missing token shows up in the UI instead of crashing. */
  makeMail: () => MailClient;
  makeClassifier: () => Classifier;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
  exiting: () => boolean;
  now?: () => Date;
}

function friendly(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') {
    return `Missing file ${e.path ?? ''}. Check the secrets folder, then run: docker compose run --rm --service-ports auth`;
  }
  return String(err);
}

/**
 * Idles until the UI asks it to start. Every process start begins stopped, so
 * `docker compose up` never begins touching your mail by itself.
 */
export async function runPoller(o: PollerOptions): Promise<void> {
  const now = o.now ?? (() => new Date());
  writeControl(o.dataDir, false);

  let status: Status = {
    state: 'stopped',
    progress: null,
    lastCycle: null,
    lastError: null,
    updatedAt: now().toISOString(),
  };
  const save = (patch: Partial<Status>) => {
    status = { ...status, ...patch, updatedAt: now().toISOString() };
    writeStatus(o.dataDir, status);
  };
  const wanted = () => readControl(o.dataDir).running;
  save({});
  o.log.info('stopped. Open the UI (http://localhost:8080) and press Start');

  let mail: MailClient | null = null;
  let classifier: Classifier | null = null;
  let scannedBacklogDays: number | null = null;

  while (!o.exiting()) {
    touchHeartbeat(o.dataDir);

    if (!wanted()) {
      scannedBacklogDays = null;
      if (status.state !== 'stopped') save({ state: 'stopped', progress: null });
      await o.sleep(2000);
      continue;
    }

    try {
      mail ??= o.makeMail();
      classifier ??= o.makeClassifier();
    } catch (err) {
      o.log.error({ err: String(err) }, 'cannot start');
      writeControl(o.dataDir, false);
      save({ state: 'stopped', progress: null, lastError: friendly(err) });
      continue;
    }

    const config = o.reloadConfig();
    let waitSeconds = config.settings.poll_interval_seconds;
    save({ state: 'scanning', progress: null, lastError: null });
    try {
      const stats = await runCycle({
        config,
        scanBacklog: scannedBacklogDays !== config.settings.backlog_days,
        mail,
        classifier,
        state: o.state,
        log: o.log,
        now,
        hooks: {
          shouldStop: () => o.exiting() || !wanted(),
          onProgress: (done, total) => {
            touchHeartbeat(o.dataDir);
            save({ progress: { done, total } });
          },
        },
      });
      // Start and lookback changes must revisit older inbox mail. Only a completed scan
      // switches back to incremental history; failed or stopped scans need another pass.
      if (!stats.stopped && stats.failed === 0) scannedBacklogDays = config.settings.backlog_days;
      save({
        state: stats.stopped ? 'stopped' : 'idle',
        progress: null,
        lastCycle: { at: now().toISOString(), ...stats, dryRun: config.settings.dry_run },
      });
      o.log.info({ ...stats, dry_run: config.settings.dry_run }, 'cycle complete');
    } catch (err) {
      if (err instanceof GmailQuotaError) {
        waitSeconds = Math.max(waitSeconds, Math.ceil((err.retryAt - Date.now()) / 1000));
      }
      o.log.error({ err: String(err) }, 'cycle failed');
      save({ state: 'idle', progress: null, lastError: String(err) });
    }

    // wait for the next check, but notice Stop within a second
    for (let i = 0; i < waitSeconds && !o.exiting(); i++) {
      if (!wanted()) {
        scannedBacklogDays = null;
        break;
      }
      touchHeartbeat(o.dataDir);
      await o.sleep(1000);
    }
  }
  save({ state: 'stopped', progress: null });
}
