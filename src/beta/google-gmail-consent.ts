import { timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { SCOPES } from '../gmail.js';

/** Separate OAuth client/project from sign-in; callers must also enforce active approval. */
export class GoogleGmailConsentProvider {
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
      throw new Error('valid Google Gmail credentials and HTTPS callback required');
    }
    this.client = client ?? new OAuth2Client({ clientId, clientSecret, redirectUri });
  }

  authorizationUrl(state: string, nonce: string, challenge: string): string {
    return this.client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['openid', 'email', ...SCOPES],
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  async exchange(
    code: string,
    verifier: string,
    expectedNonce: string,
    expectedSubject: string,
  ): Promise<string> {
    if (
      !code ||
      code.length > 4096 ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) ||
      !/^[A-Za-z0-9_-]{43}$/.test(expectedNonce) ||
      !expectedSubject ||
      expectedSubject.length > 255
    ) {
      throw new Error('invalid Gmail consent response');
    }
    const { tokens } = await this.client.getToken({
      code,
      codeVerifier: verifier,
      redirect_uri: this.redirectUri,
    });
    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token)
      throw new Error('Gmail consent requires a refresh token');
    const ticket = await this.client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.clientId,
    });
    const payload = ticket.getPayload();
    const received =
      typeof payload?.nonce === 'string' ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    const expected = Buffer.from(expectedNonce);
    if (
      payload?.sub !== expectedSubject ||
      payload.email_verified !== true ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new Error('Gmail account verification failed');
    }
    const info = await this.client.getTokenInfo(tokens.access_token);
    if (
      info.aud !== this.clientId ||
      (info.sub && info.sub !== expectedSubject) ||
      !SCOPES.every((scope) => info.scopes.includes(scope))
    ) {
      throw new Error('Gmail permission verification failed');
    }
    return tokens.refresh_token;
  }

  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.client.revokeToken(refreshToken);
    } catch {
      // Provider errors can contain a URL with the token. Never forward or log them.
      throw new Error('Gmail revocation failed');
    }
  }
}
