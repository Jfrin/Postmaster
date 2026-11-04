import { AsyncLocalStorage } from 'node:async_hooks';
import { OAuth2Client } from 'google-auth-library';
import nodeFetch from 'node-fetch';
import type { GmailRequestGuard, GmailRequestKind } from '../gmail.js';

interface Attempt {
  kind: GmailRequestKind;
  guard: GmailRequestGuard;
  dispatched: boolean;
  guardFailure?: { error: unknown };
}

/**
 * Guard at the fetch boundary, after OAuth refresh and gaxios request preparation. An attempt
 * is charged when fetch is invoked, even if it fails before bytes reach Google. External state
 * changes and network delivery cannot be made atomic with the SQLite authorization transaction.
 */
export class BetaGmailOAuthClient extends OAuth2Client {
  private readonly attempts = new AsyncLocalStorage<Attempt>();

  execute<T>(kind: GmailRequestKind, guard: GmailRequestGuard, request: () => Promise<T>) {
    return this.attempts.run({ kind, guard, dispatched: false }, request);
  }

  protected override async requestAsync<T>(opts: Parameters<OAuth2Client['request']>[0]) {
    const attempt = this.attempts.getStore();
    if (!attempt) throw new Error('Gmail request without dispatch guard');
    const url = new URL(String(opts.url));
    if (url.protocol !== 'https:' || url.host !== 'gmail.googleapis.com' || opts.adapter) {
      throw new Error('invalid Gmail transport');
    }
    // No gaxios retry, redirect, custom adapter, or OAuth 401/403 replay can issue an
    // unguarded second request. Refresh requests use the separate OAuth transport path.
    opts.retry = false;
    opts.redirect = 'manual';
    opts.fetchImplementation = ((
      input: Parameters<NonNullable<typeof opts.fetchImplementation>>[0],
      init: Parameters<NonNullable<typeof opts.fetchImplementation>>[1],
    ) => {
      const destination = new URL(String(input));
      if (destination.protocol !== 'https:' || destination.host !== 'gmail.googleapis.com') {
        throw new Error('invalid Gmail destination');
      }
      if (attempt.dispatched) throw new Error('duplicate Gmail dispatch');
      attempt.dispatched = true;
      try {
        attempt.guard(attempt.kind);
      } catch (error) {
        attempt.guardFailure = { error };
        throw error;
      }
      return nodeFetch(
        input as Parameters<typeof nodeFetch>[0],
        init as Parameters<typeof nodeFetch>[1],
      );
    }) as unknown as NonNullable<typeof opts.fetchImplementation>;
    try {
      return await super.requestAsync<T>(opts, true);
    } catch (error) {
      // Gaxios wraps fetch errors, including policy errors. Preserve their original type so
      // quota handling and fail-closed worker behavior cannot mistake them for network errors.
      if (attempt.guardFailure) throw attempt.guardFailure.error;
      throw error;
    }
  }
}
