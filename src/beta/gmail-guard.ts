import type { GmailRequestGuard } from '../gmail.js';
import type { BetaAccessStore, WorkerLease } from './access.js';

/** Bind to a verified user's subject. A multi-user worker must never omit this guard. */
export function createBetaGmailGuard(
  store: BetaAccessStore,
  subject: string,
  now: () => number = Date.now,
): GmailRequestGuard {
  return (kind) => store.authorizeGmailAttempt(subject, now(), kind);
}

/** Multi-user workers must acquire/renew a lease and use this fenced guard. */
export function createLeasedBetaGmailGuard(
  store: BetaAccessStore,
  lease: WorkerLease,
  now: () => number = Date.now,
): GmailRequestGuard {
  return (kind) => store.authorizeLeasedGmailAttempt(lease, now, kind);
}
