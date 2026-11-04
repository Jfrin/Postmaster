import { timingSafeEqual } from 'node:crypto';
import {
  CodeChallengeMethod,
  OAuth2Client,
  type Credentials,
  type LoginTicket,
} from 'google-auth-library';

export interface VerifiedIdentity {
  subject: string;
  verifiedEmail: string;
  /** Google is authoritative for Gmail and verified Workspace hosted domains. */
  emailAuthoritative?: boolean;
}

/** Identity-only client. Gmail consent must use a separate client/project and flow. */
export class GoogleIdentityProvider {
  private readonly client: OAuth2Client;

  constructor(
    private readonly clientId: string,
    clientSecret: string,
    private readonly redirectUri: string,
    client?: OAuth2Client,
  ) {
    const url = new URL(redirectUri);
    if (
      !clientId ||
      !clientSecret ||
      url.protocol !== 'https:' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('valid Google identity credentials and HTTPS callback required');
    }
    this.client = client ?? new OAuth2Client({ clientId, clientSecret, redirectUri });
  }

  authorizationUrl(state: string, nonce: string, challenge: string): string {
    return this.client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'select_account',
    });
  }

  async exchange(code: string, verifier: string, expectedNonce: string): Promise<VerifiedIdentity> {
    if (
      !code ||
      code.length > 4096 ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) ||
      !/^[A-Za-z0-9_-]{43}$/.test(expectedNonce)
    )
      throw new Error('invalid sign-in response');
    let tokens: Credentials;
    try {
      ({ tokens } = await this.client.getToken({
        code,
        codeVerifier: verifier,
        redirect_uri: this.redirectUri,
      }));
    } catch (error) {
      console.warn('beta sign-in: Google token exchange failed');
      throw error;
    }
    if (!tokens.id_token) throw new Error('Google identity token missing');
    let ticket: LoginTicket;
    try {
      ticket = await this.client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.clientId,
      });
    } catch (error) {
      console.warn('beta sign-in: Google identity token verification failed');
      throw error;
    }
    const payload = ticket.getPayload();
    const nonce = payload?.nonce;
    const received = typeof nonce === 'string' ? Buffer.from(nonce) : Buffer.alloc(0);
    const expected = Buffer.from(expectedNonce);
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      typeof nonce !== 'string' ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      console.warn('beta sign-in: identity claims or nonce invalid');
      throw new Error('Google identity verification failed');
    }
    const domain = payload.email.split('@').pop()?.toLowerCase();
    return {
      subject: payload.sub,
      verifiedEmail: payload.email,
      emailAuthoritative:
        domain === 'gmail.com' ||
        domain === 'googlemail.com' ||
        (typeof payload.hd === 'string' && payload.hd.toLowerCase() === domain),
    };
  }
}
