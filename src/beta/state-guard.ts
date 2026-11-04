import type { StateWriteGuard } from '../state.js';
import { LeaseLostError, type WorkerLease } from './access.js';

/** Check authorization and the worker fence in the same SQLite transaction as a state write. */
export function createBetaStateWriteGuard(
  lease: WorkerLease,
  now: () => number = Date.now,
): StateWriteGuard {
  return (db, userId) => {
    const time = now();
    if (
      userId !== lease.subject ||
      !Number.isSafeInteger(time) ||
      time < 0 ||
      !Number.isSafeInteger(lease.fence) ||
      lease.fence < 1
    )
      throw new LeaseLostError('lease lost');
    const allowed = db
      .prepare(
        `SELECT 1 FROM beta_access_requests AS access
      JOIN beta_processing_controls AS controls ON controls.subject = access.subject
      JOIN beta_gmail_tokens AS tokens ON tokens.subject = access.subject
      JOIN beta_worker_leases AS leases ON leases.subject = access.subject
      WHERE access.subject = ? AND access.status = 'approved' AND access.expires_at > ?
        AND controls.running = 1 AND tokens.enabled = 1
        AND leases.owner = ? AND leases.fence = ? AND leases.expires_at > ?`,
      )
      .get(lease.subject, time, lease.owner, lease.fence, time);
    if (!allowed) throw new LeaseLostError('lease lost');
    if (lease.scheduler) {
      const held = db
        .prepare(
          `SELECT 1 FROM beta_scheduler_lease
        WHERE id = 1 AND owner = ? AND fence = ? AND expires_at > ?`,
        )
        .get(lease.scheduler.owner, lease.scheduler.fence, time);
      if (!held) throw new LeaseLostError('scheduler lease lost');
    }
  };
}
