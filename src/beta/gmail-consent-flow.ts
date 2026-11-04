import { AccessDeniedError, type BetaAccessStore } from './access.js';
import type { GmailConsentStateStore } from './gmail-consent-state.js';
import type { GmailTokenVault } from './token-vault.js';

export interface GmailConsentProvider {
  authorizationUrl(state: string, nonce: string, challenge: string): string;
  exchange(code: string, verifier: string, nonce: string, subject: string): Promise<string>;
  revoke(refreshToken: string): Promise<void>;
}

/** Separate from sign-in. Only verified, approved users may initiate or complete consent. */
export class GmailConsentFlow {
  constructor(
    private readonly states: GmailConsentStateStore,
    private readonly access: BetaAccessStore,
    private readonly vault: GmailTokenVault,
    private readonly provider: GmailConsentProvider,
    private readonly now: () => number = Date.now,
  ) {}

  start(subject: string): { location: string; cookie: string } {
    const now = this.now();
    if (!this.access.isActive(subject, now)) throw new AccessDeniedError('access not active');
    const start = this.states.start(subject, now);
    return {
      location: this.provider.authorizationUrl(start.state, start.nonce, start.challenge),
      cookie: start.cookie,
    };
  }

  isConnected(subject: string): boolean {
    return this.vault.has(subject);
  }

  async finish(
    subject: string,
    state: string,
    code: string,
    cookieHeader: string | undefined,
  ): Promise<void> {
    if (!code || code.length > 4096) throw new Error('invalid Gmail consent response');
    if (!this.access.isActive(subject, this.now()))
      throw new AccessDeniedError('access not active');
    const pending = this.states.consume(state, cookieHeader, subject, this.now());
    if (!pending) throw new Error('invalid Gmail consent response');
    const refreshToken = await this.provider.exchange(
      code,
      pending.verifier,
      pending.nonce,
      subject,
    );
    // Recheck inside the same database transaction as storage, after the network exchange.
    this.vault.saveIfActive(subject, refreshToken, this.now());
  }

  /** Caller must authorize the signed-in owner; works even after testing access expires. */
  async disconnect(subject: string): Promise<void> {
    this.access.stopProcessing(subject);
    const token = this.vault.disableAndLoad(subject);
    if (!token) return;
    try {
      await this.provider.revoke(token);
    } catch {
      throw new Error('Gmail revocation failed');
    }
    if (!this.vault.deleteIfUnchanged(subject, token)) throw new Error('Gmail connection changed');
  }

  /** Explicit local deletion only; this does not revoke the Google grant or delete backups. */
  forget(subject: string): void {
    this.access.stopProcessing(subject);
    this.vault.delete(subject);
  }
}
