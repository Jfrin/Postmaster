import type { IdentityLoginStateStore } from './oauth-state.js';
import { BetaSessionStore } from './session-store.js';
import type { VerifiedIdentity } from './google-identity.js';

export interface IdentityProvider {
  authorizationUrl(state: string, nonce: string, challenge: string): string;
  exchange(code: string, verifier: string, nonce: string): Promise<VerifiedIdentity>;
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
    if (!pending) throw new Error('invalid sign-in response');
    const identity = await this.provider.exchange(code, pending.verifier, pending.nonce);
    const cookie = this.sessions.issue(
      identity.subject,
      identity.verifiedEmail,
      now,
      12 * 60 * 60 * 1000,
    );
    // Revoke the browser's previous session only after the new identity has been verified.
    this.sessions.revoke(cookieHeader);
    return cookie;
  }

  logout(cookieHeader: string | undefined): string {
    this.sessions.revoke(cookieHeader);
    return BetaSessionStore.clearCookie();
  }
}
