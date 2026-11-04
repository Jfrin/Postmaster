import type { IdentityLoginStateStore } from './oauth-state.js';
import { BetaSessionStore } from './session-store.js';
import type { VerifiedIdentity } from './google-identity.js';

export interface IdentityProvider {
  authorizationUrl(state: string, nonce: string, challenge: string): string;
  exchange(code: string, verifier: string, nonce: string): Promise<VerifiedIdentity>;
}

export class IdentityAccessDeniedError extends Error {}
export class IdentityStateError extends Error {}

/** Limit a private owner test before expanding access to invited testers. */
export function restrictIdentityProvider(
  provider: IdentityProvider,
  subject: string,
): IdentityProvider {
  if (!subject) throw new Error('owner subject required');
  return {
    authorizationUrl: (state, nonce, challenge) =>
      provider.authorizationUrl(state, nonce, challenge),
    async exchange(code, verifier, nonce) {
      const identity = await provider.exchange(code, verifier, nonce);
      if (identity.subject !== subject) {
        console.warn('beta sign-in: owner subject mismatch');
        throw new IdentityAccessDeniedError('identity is not permitted');
      }
      return identity;
    },
  };
}

/** Google sign-in only; it never requests Gmail access or stores a Google access token. */
export class IdentityFlow {
  constructor(
    private readonly states: IdentityLoginStateStore,
    private readonly sessions: BetaSessionStore,
    private readonly provider: IdentityProvider,
  ) {}

  start(now: number): { location: string; cookie: string } {
    const start = this.states.start(now);
    return {
      location: this.provider.authorizationUrl(start.state, start.nonce, start.challenge),
      cookie: start.cookie,
    };
  }

  async finish(
    state: string,
    code: string,
    cookieHeader: string | undefined,
    now: number,
  ): Promise<string> {
    if (!code || code.length > 4096) throw new Error('invalid sign-in response');
    const pending = this.states.consume(state, cookieHeader, now);
    if (!pending) {
      console.warn('beta sign-in: state or browser cookie invalid');
      throw new IdentityStateError('invalid sign-in response');
    }
    let identity: VerifiedIdentity;
    try {
      identity = await this.provider.exchange(code, pending.verifier, pending.nonce);
    } catch (error) {
      console.warn('beta sign-in: identity exchange failed');
      throw error;
    }
    let cookie: string;
    try {
      cookie = this.sessions.issue(
        identity.subject,
        identity.verifiedEmail,
        now,
        12 * 60 * 60 * 1000,
      );
    } catch (error) {
      console.warn('beta sign-in: session creation failed');
      throw error;
    }
    // Revoke the browser's previous session only after the new identity has been verified.
    this.sessions.revoke(cookieHeader);
    return cookie;
  }

  logout(cookieHeader: string | undefined): string {
    this.sessions.revoke(cookieHeader);
    return BetaSessionStore.clearCookie();
  }
}
