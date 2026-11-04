import { randomBytes } from 'node:crypto';
import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import type { Classifier } from '../classifier.js';
import { GmailClient } from '../gmail.js';
import { silentLogger } from '../logger.js';
import { runCycle, type CycleStats } from '../pipeline.js';
import { State } from '../state.js';
import {
  AccessDeniedError,
  BetaAccessStore,
  DailyReadLimitError,
  LeaseLostError,
  type SchedulerLease,
} from './access.js';
import { createLeasedBetaGmailGuard } from './gmail-guard.js';
import { createBetaStateWriteGuard } from './state-guard.js';
import { GmailTokenVault } from './token-vault.js';
import { BetaUserConfigStore } from './user-config.js';

export type GmailServiceFactory = (subject: string, refreshToken: string) => gmail_v1.Gmail;

/** The factory is trusted application code; browser-supplied credentials must never be used. */
export function googleGmailServiceFactory(
  clientId: string,
  clientSecret: string,
): GmailServiceFactory {
  if (!clientId || !clientSecret) throw new Error('Gmail OAuth client credentials required');
  return (_subject, refreshToken) => {
    const auth = new OAuth2Client({ clientId, clientSecret });
    auth.setCredentials({ refresh_token: refreshToken });
    return gmailApi({ version: 'v1', auth });
  };
}

export interface BetaWorkerOptions {
  /** Shared SQLite file for access, connection, configuration, leases and processing state. */
  databasePath: string;
  vaultKey: Uint8Array;
  defaultConfigYaml: string;
  makeGmailService: GmailServiceFactory;
  classifier: Classifier;
  now?: () => Date;
  leaseMs?: number;
}

/**
 * A single-user cycle primitive, not a scheduler. No HTTP handler may supply an arbitrary
 * subject or Gmail service. A trusted scheduler must manage user selection, restart/reset,
 * rate limits and lifecycle. Calls already in flight may finish after Stop or expiry.
 */
export class BetaCycleRunner {
  private readonly access: BetaAccessStore;
  private readonly vault: GmailTokenVault;
  private readonly configs: BetaUserConfigStore;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private running = 0;
  private closed = false;

  constructor(private readonly options: BetaWorkerOptions) {
    if (!options.databasePath || options.databasePath === ':memory:')
      throw new Error('shared database file required');
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000 || this.leaseMs > 300_000)
      throw new Error('invalid lease duration');
    this.now = options.now ?? (() => new Date());
    this.access = new BetaAccessStore(options.databasePath);
    try {
      this.vault = new GmailTokenVault(options.databasePath, options.vaultKey);
    } catch (error) {
      this.access.close();
      throw error;
    }
    try {
      this.configs = new BetaUserConfigStore(options.databasePath, options.defaultConfigYaml);
    } catch (error) {
      this.vault.close();
      this.access.close();
      throw error;
    }
  }

  close(): void {
    if (this.running) throw new Error('worker cycles still running');
    if (this.closed) return;
    this.configs.close();
    this.vault.close();
    this.access.close();
    this.closed = true;
  }

  async run(
    subject: string,
    scheduler?: SchedulerLease,
  ): Promise<
    | { status: 'busy' }
    | { status: 'completed'; stats: CycleStats; pollIntervalSeconds: number; limitReached: boolean }
  > {
    if (this.closed) throw new Error('worker closed');
    const owner = randomBytes(24).toString('base64url');
    const lease = this.access.acquireLease(
      subject,
      owner,
      this.now().getTime(),
      this.leaseMs,
      scheduler,
    );
    if (!lease) return { status: 'busy' };
    this.running++;
    let state: State | undefined;
    let lost = false;
    let limitReached = false;
    const timer = setInterval(
      () => {
        try {
          if (!this.access.renewLease(lease, this.now().getTime(), this.leaseMs)) lost = true;
        } catch {
          lost = true;
        }
      },
      Math.max(250, Math.floor(this.leaseMs / 3)),
    );
    timer.unref();
    try {
      const config = this.configs.get(subject, this.now().getTime());
      const refreshToken = this.vault.loadIfActive(subject, this.now().getTime());
      if (!refreshToken) throw new AccessDeniedError('Gmail connection not active');
      const fencedGuard = createLeasedBetaGmailGuard(this.access, lease, () =>
        this.now().getTime(),
      );
      const guard = (kind: Parameters<typeof fencedGuard>[0]) => {
        try {
          fencedGuard(kind);
        } catch (error) {
          if (error instanceof DailyReadLimitError) limitReached = true;
          throw error;
        }
      };
      const mail = new GmailClient(this.options.makeGmailService(subject, refreshToken), guard);
      state = new State(
        this.options.databasePath,
        subject,
        createBetaStateWriteGuard(lease, () => this.now().getTime()),
      );
      const scanBacklog = this.access.needsBacklogScan(
        lease,
        config.settings.backlog_days,
        this.now().getTime(),
      );
      const stats = await runCycle({
        config,
        mail,
        state,
        scanBacklog,
        classifier: this.options.classifier,
        log: silentLogger,
        now: this.now,
        hooks: {
          shouldStop: () => {
            if (lost || limitReached) return true;
            try {
              this.access.authorizeLeasedGmailAttempt(lease, this.now().getTime(), 'other');
              return false;
            } catch (error) {
              if (error instanceof AccessDeniedError || error instanceof LeaseLostError)
                return true;
              throw error;
            }
          },
        },
      }).catch((error: unknown) => {
        try {
          this.access.recordCycle(
            lease,
            { seen: 0, processed: 0, failed: 1 },
            this.now().getTime(),
          );
        } catch {
          // Preserve the original failure; a lost lease must never be used for metrics writes.
        }
        throw error;
      });
      if (scanBacklog && !lost && !stats.failed && !stats.stopped) {
        this.access.completeBacklogScan(lease, config.settings.backlog_days, this.now().getTime());
      }
      try {
        this.access.recordCycle(lease, stats, this.now().getTime());
      } catch (error) {
        if (!(error instanceof AccessDeniedError) && !(error instanceof LeaseLostError))
          throw error;
      }
      return {
        status: 'completed',
        stats,
        pollIntervalSeconds: config.settings.poll_interval_seconds,
        limitReached,
      };
    } finally {
      clearInterval(timer);
      try {
        state?.close();
      } finally {
        try {
          this.access.releaseLease(lease);
        } finally {
          this.running--;
        }
      }
    }
  }
}
