import { randomBytes } from 'node:crypto';
import { GmailQuotaError } from '../gmail-quota.js';
import type { BetaAccessStore, SchedulerLease } from './access.js';
import type { BetaCycleRunner } from './worker.js';

type CycleRunner = Pick<BetaCycleRunner, 'run'>;
interface NextRun {
  generation: number;
  at: number;
}

/**
 * Scheduler prototype with a database-backed leader lease and fenced per-user work.
 */
export class BetaScheduler {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly next = new Map<string, NextRun>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lease: SchedulerLease | null = null;
  private active = false;
  private stopping: Promise<void> | null = null;
  private cursor = 0;
  private schedulerError = false;
  private readonly leaseMs = 30_000;
  private nextMaintenanceAt: number | null = null;

  constructor(
    private readonly access: BetaAccessStore,
    private readonly runner: CycleRunner,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = 1,
    private readonly tickMs = 5000,
    private readonly maintenance?: (now: number) => void,
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8)
      throw new Error('invalid concurrency');
    if (!Number.isSafeInteger(tickMs) || tickMs < 1000 || tickMs > 60_000)
      throw new Error('invalid scheduler interval');
  }

  /** Always starts stopped; users must explicitly start processing after each scheduler restart. */
  start(): void {
    if (this.active || this.stopping || this.lease)
      throw new Error('scheduler already started or stopping');
    const lease = this.access.acquireScheduler(
      randomBytes(24).toString('base64url'),
      this.now(),
      this.leaseMs,
    );
    if (!lease) throw new Error('scheduler lease unavailable');
    this.lease = lease;
    this.next.clear();
    this.nextMaintenanceAt = null;
    this.schedulerError = false;
    this.active = true;
    this.heartbeat = setInterval(() => {
      this.renew();
    }, this.leaseMs / 3);
    this.heartbeat.unref();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.schedulerError = true;
      });
    }, this.tickMs);
    this.timer.unref();
  }

  status(): { online: boolean; runningCycles: number; schedulerError: boolean } {
    if (this.active && this.lease) {
      try {
        if (!this.access.schedulerHeld(this.lease, this.now())) this.lostLease();
      } catch {
        this.lostLease();
      }
    }
    return {
      online: this.active,
      runningCycles: this.inFlight.size,
      schedulerError: this.schedulerError,
    };
  }

  private lostLease(): void {
    this.active = false;
    this.schedulerError = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
  }

  private renew(): boolean {
    if (!this.active || !this.lease) return false;
    try {
      if (this.access.renewScheduler(this.lease, this.now(), this.leaseMs)) return true;
    } catch {
      // Fail closed when lease ownership cannot be verified.
    }
    this.lostLease();
    return false;
  }

  async tick(): Promise<void> {
    if (!this.renew()) return;
    const lease = this.lease!;
    const time = this.now();
    if (this.maintenance && (this.nextMaintenanceAt === null || time >= this.nextMaintenanceAt)) {
      try {
        this.maintenance(time);
        this.nextMaintenanceAt = time + 60 * 60 * 1000;
      } catch (error) {
        // Fail closed for this tick; retry maintenance before launching further work.
        this.schedulerError = true;
        throw error;
      }
    }
    const users = this.access.runnableUsers(time);
    const present = new Set(users.map((user) => user.subject));
    for (const subject of this.next.keys()) if (!present.has(subject)) this.next.delete(subject);
    const launched: Promise<void>[] = [];
    const start = this.cursor;
    for (
      let offset = 0;
      offset < users.length && this.inFlight.size < this.maxConcurrent;
      offset++
    ) {
      const index = (start + offset) % users.length;
      const user = users[index]!;
      const scheduled = this.next.get(user.subject);
      if (
        this.inFlight.has(user.subject) ||
        (scheduled?.generation === user.generation && scheduled.at > time)
      )
        continue;
      this.cursor = (index + 1) % users.length;
      const job = Promise.resolve()
        .then(() => this.runner.run(user.subject, lease))
        .then((result) => {
          const finished = this.now();
          let at: number;
          if (result.status === 'busy') at = finished + 5000;
          else if (result.limitReached) {
            const tomorrow = new Date(finished);
            tomorrow.setUTCHours(24, 0, 0, 0);
            at = tomorrow.getTime();
          } else at = finished + result.pollIntervalSeconds * 1000;
          this.next.set(user.subject, { generation: user.generation, at });
        })
        .catch((error: unknown) => {
          const finished = this.now();
          // Never persist or log raw Gmail/Azure errors: they can contain sensitive data.
          const at =
            error instanceof GmailQuotaError
              ? Math.max(finished + 1000, error.retryAt)
              : finished + 300_000;
          this.next.set(user.subject, { generation: user.generation, at });
        })
        .finally(() => {
          this.inFlight.delete(user.subject);
        });
      this.inFlight.set(user.subject, job);
      launched.push(job);
    }
    this.schedulerError = false;
    await Promise.all(launched);
  }

  /** Stop issuing work, invalidate leases and wait for already-started calls to settle. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.lease) return Promise.resolve();
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    const lease = this.lease;
    this.stopping = (async () => {
      try {
        this.access.releaseScheduler(lease, this.now());
      } finally {
        await Promise.allSettled([...this.inFlight.values()]);
        this.next.clear();
        this.lease = null;
      }
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
}
