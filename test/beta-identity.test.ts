import { createHash } from 'node:crypto';
import type { OAuth2Client } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import { GoogleIdentityProvider } from '../src/beta/google-identity.js';
import { IdentityLoginStateStore } from '../src/beta/oauth-state.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const callback = 'https://beta.example.com/auth/google/callback';

describe('identity-only Google login foundation', () => {
  it('logs only a fixed label when Google token exchange fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { getToken: vi.fn().mockRejectedValue(new Error('sensitive details')) };
    try {
      const provider = new GoogleIdentityProvider(
        'client',
        'secret',
        callback,
        client as unknown as OAuth2Client,
      );
      await expect(provider.exchange('code', 'v'.repeat(86), 'n'.repeat(43))).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith('beta sign-in: Google token exchange failed');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('sensitive');
    } finally {
      warn.mockRestore();
    }
  });
  it('binds the browser to single-use state, nonce and PKCE', () => {
    const store = new IdentityLoginStateStore(':memory:');
    try {
      const start = store.start(now);
      const cookie = start.cookie.split(';')[0]!;
      expect(start.cookie).toContain('Secure; HttpOnly; SameSite=Lax');
      expect(start.cookie).not.toContain('Domain=');
      expect(store.consume(start.state, undefined, now)).toBeNull();
      expect(store.consume(start.state, `${cookie}; ${cookie}`, now)).toBeNull();
      expect(store.consume('x'.repeat(43), cookie, now)).toBeNull();
      const state = store.consume(start.state, cookie, now)!;
      expect(state.nonce).toBe(start.nonce);
      expect(createHash('sha256').update(state.verifier).digest('base64url')).toBe(start.challenge);
      expect(store.consume(start.state, cookie, now)).toBeNull();
      expect(IdentityLoginStateStore.clearCookie()).toContain('Max-Age=0');
    } finally {
      store.close();
    }
  });

  it('expires pending states and rejects invalid values', () => {
    const store = new IdentityLoginStateStore(':memory:');
    try {
      expect(() => store.start(-1)).toThrow('timestamp');
      const start = store.start(now);
      const cookie = start.cookie.split(';')[0]!;
      expect(store.consume(start.state, cookie, now + 600_000)).toBeNull();
      expect(store.consume('bad', cookie, now)).toBeNull();
      expect(store.consume(start.state, cookie, -1)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('uses identity-only scopes, PKCE and verified Google identity claims', async () => {
    const nonce = 'n'.repeat(43);
    const client = {
      generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth'),
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'synthetic-id-token' } }),
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub',
          email: 'test@example.com',
          email_verified: true,
          nonce,
        }),
      }),
    };
    const provider = new GoogleIdentityProvider(
      'client-id',
      'client-secret',
      callback,
      client as unknown as OAuth2Client,
    );
    provider.authorizationUrl('state', nonce, 'challenge');
    expect(client.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: ['openid', 'email', 'profile'],
        access_type: 'online',
        code_challenge_method: 'S256',
        nonce,
      }),
    );
    expect(await provider.exchange('code', 'v'.repeat(86), nonce)).toEqual({
      subject: 'google-sub',
      verifiedEmail: 'test@example.com',
      emailAuthoritative: false,
    });
    expect(client.getToken).toHaveBeenCalledWith({
      code: 'code',
      codeVerifier: 'v'.repeat(86),
      redirect_uri: callback,
    });
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'synthetic-id-token',
      audience: 'client-id',
    });
  });

  it('rejects missing tokens, unverified emails, bad nonces and insecure callbacks', async () => {
    expect(
      () => new GoogleIdentityProvider('client', 'secret', 'http://beta.example.com/callback'),
    ).toThrow();
    const client = {
      getToken: vi.fn().mockResolvedValue({ tokens: {} }),
      verifyIdToken: vi.fn(),
    };
    const provider = new GoogleIdentityProvider(
      'client',
      'secret',
      callback,
      client as unknown as OAuth2Client,
    );
    const nonce = 'n'.repeat(43);
    await expect(provider.exchange('', 'v'.repeat(86), nonce)).rejects.toThrow('invalid');
    await expect(provider.exchange('code', 'bad', nonce)).rejects.toThrow('invalid');
    await expect(provider.exchange('code', 'v'.repeat(86), nonce)).rejects.toThrow('missing');
    client.getToken.mockResolvedValue({ tokens: { id_token: 'fake' } });
    for (const payload of [
      { sub: 'user', email: 'test@example.com', email_verified: false, nonce },
      { sub: 'user', email: 'test@example.com', email_verified: true, nonce: 'x'.repeat(43) },
      { sub: '', email: 'test@example.com', email_verified: true, nonce },
      { sub: 'user', email: 'test@example.com', email_verified: true, nonce: 'é'.repeat(43) },
    ]) {
      client.verifyIdToken.mockResolvedValue({ getPayload: () => payload });
      await expect(provider.exchange('code', 'v'.repeat(86), nonce)).rejects.toThrow(
        'verification failed',
      );
    }
  });

  it('accepts Gmail and matching hosted domains as authoritative, but not external addresses', async () => {
    const nonce = 'n'.repeat(43);
    let payload = { sub: 'user', email: 'test@gmail.com', email_verified: true, nonce, hd: '' };
    const client = {
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake' } }),
      verifyIdToken: vi.fn().mockImplementation(async () => ({ getPayload: () => payload })),
    };
    const provider = new GoogleIdentityProvider(
      'client',
      'secret',
      callback,
      client as unknown as OAuth2Client,
    );
    expect((await provider.exchange('code', 'v'.repeat(86), nonce)).emailAuthoritative).toBe(true);
    payload = { ...payload, email: 'test@company.example', hd: 'company.example' };
    expect((await provider.exchange('code', 'v'.repeat(86), nonce)).emailAuthoritative).toBe(true);
    payload = { ...payload, hd: 'other.example' };
    expect((await provider.exchange('code', 'v'.repeat(86), nonce)).emailAuthoritative).toBe(false);
  });
});
