import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuth2Client } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import { AccessDeniedError, BetaAccessStore } from '../src/beta/access.js';
import { GmailConsentFlow } from '../src/beta/gmail-consent-flow.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import { GoogleGmailConsentProvider } from '../src/beta/google-gmail-consent.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { SCOPES } from '../src/gmail.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const callback = 'https://beta.example.com/auth/google/gmail/callback';

describe('Gmail connection foundations', () => {
  it('logs a fixed label without provider error details on token exchange failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { getToken: vi.fn().mockRejectedValue(new Error('sensitive token')) };
    try {
      const provider = new GoogleGmailConsentProvider(
        'gmail-client',
        'secret',
        callback,
        client as unknown as OAuth2Client,
      );
      await expect(
        provider.exchange('code', 'v'.repeat(86), 'n'.repeat(43), 'alice'),
      ).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith('beta Gmail consent: Google token exchange failed');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('sensitive');
    } finally {
      warn.mockRestore();
    }
  });
  it('binds consent state to the browser and the signed-in subject, expiring and consuming once', () => {
    const states = new GmailConsentStateStore(':memory:');
    try {
      const start = states.start('alice', now);
      const cookie = start.cookie.split(';')[0]!;
      expect(start.cookie).toContain('Secure; HttpOnly; SameSite=Lax');
      expect(states.consume(start.state, undefined, 'alice', now)).toBeNull();
      expect(states.consume(start.state, `${cookie}; ${cookie}`, 'alice', now)).toBeNull();
      expect(states.consume(start.state, cookie, 'bob', now)).toBeNull();
      const pending = states.consume(start.state, cookie, 'alice', now)!;
      expect(pending.nonce).toBe(start.nonce);
      expect(createHash('sha256').update(pending.verifier).digest('base64url')).toBe(
        start.challenge,
      );
      expect(states.consume(start.state, cookie, 'alice', now)).toBeNull();
      const expired = states.start('alice', now);
      expect(
        states.consume(expired.state, expired.cookie.split(';')[0], 'alice', now + 600_000),
      ).toBeNull();
      expect(GmailConsentStateStore.clearCookie()).toContain('Max-Age=0');
    } finally {
      states.close();
    }
  });

  it('requests a separate offline Gmail grant and verifies account, nonce and granted scope', async () => {
    const nonce = 'n'.repeat(43);
    const client = {
      generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth'),
      getToken: vi.fn().mockResolvedValue({
        tokens: { id_token: 'id', access_token: 'access', refresh_token: 'refresh' },
      }),
      verifyIdToken: vi
        .fn()
        .mockResolvedValue({ getPayload: () => ({ sub: 'alice', email_verified: true, nonce }) }),
      getTokenInfo: vi
        .fn()
        .mockResolvedValue({ aud: 'gmail-client', sub: 'alice', scopes: SCOPES }),
      revokeToken: vi.fn().mockResolvedValue({}),
    };
    const provider = new GoogleGmailConsentProvider(
      'gmail-client',
      'secret',
      callback,
      client as unknown as OAuth2Client,
    );
    provider.authorizationUrl('state', nonce, 'challenge');
    expect(client.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: ['openid', 'email', ...SCOPES],
        access_type: 'offline',
        prompt: 'consent',
        code_challenge_method: 'S256',
      }),
    );
    expect(await provider.exchange('code', 'v'.repeat(86), nonce, 'alice')).toBe('refresh');
    expect(client.getToken).toHaveBeenCalledWith({
      code: 'code',
      codeVerifier: 'v'.repeat(86),
      redirect_uri: callback,
    });
    expect(client.verifyIdToken).toHaveBeenCalledWith({ idToken: 'id', audience: 'gmail-client' });
    expect(client.getTokenInfo).toHaveBeenCalledWith('access');
    await provider.revoke('refresh');
    expect(client.revokeToken).toHaveBeenCalledWith('refresh');
    client.revokeToken.mockRejectedValueOnce(new Error('secret leaked by provider'));
    await expect(provider.revoke('refresh')).rejects.toThrow('Gmail revocation failed');

    client.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'bob', email_verified: true, nonce }),
    });
    await expect(provider.exchange('code', 'v'.repeat(86), nonce, 'alice')).rejects.toThrow(
      'account verification',
    );
    client.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'alice', email_verified: true, nonce }),
    });
    client.getTokenInfo.mockResolvedValue({ aud: 'gmail-client', sub: 'alice', scopes: [] });
    await expect(provider.exchange('code', 'v'.repeat(86), nonce, 'alice')).rejects.toThrow(
      'permission verification',
    );
    client.getTokenInfo.mockResolvedValue({ aud: 'other-client', sub: 'alice', scopes: SCOPES });
    await expect(provider.exchange('code', 'v'.repeat(86), nonce, 'alice')).rejects.toThrow(
      'permission verification',
    );
    client.getToken.mockResolvedValue({ tokens: { id_token: 'id', access_token: 'access' } });
    await expect(provider.exchange('code', 'v'.repeat(86), nonce, 'alice')).rejects.toThrow(
      'refresh token',
    );
  });

  it('checks approval again after network exchange before storing an encrypted token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-consent-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    let clock = now;
    const provider = {
      authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
      exchange: vi.fn(async () => {
        clock = now + 1000;
        return 'synthetic-refresh-token';
      }),
      revoke: vi.fn(async (_token: string) => {}),
    };
    const flow = new GmailConsentFlow(states, access, vault, provider, () => clock);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 1000, 100, now);
      const start = flow.start('alice');
      const state = new URL(start.location).searchParams.get('state')!;
      await expect(flow.finish('alice', state, 'code', start.cookie.split(';')[0])).rejects.toThrow(
        AccessDeniedError,
      );
      expect(vault.load('alice')).toBeNull();
      expect(flow.isConnected('alice')).toBe(false);
      access.approve('admin', 'alice', now + 5000, 100, now + 1000);
      const again = flow.start('alice');
      await flow.finish(
        'alice',
        new URL(again.location).searchParams.get('state')!,
        'code',
        again.cookie.split(';')[0],
      );
      expect(flow.isConnected('alice')).toBe(true);
      expect(vault.loadIfActive('alice', clock)).toBe('synthetic-refresh-token');
      clock = now + 2000;
      provider.revoke.mockRejectedValueOnce(new Error('do not reveal token'));
      await expect(flow.disconnect('alice')).rejects.toThrow('Gmail revocation failed');
      expect(flow.isConnected('alice')).toBe(true);
      expect(() => access.authorizeGmailAttempt('alice', clock, 'message_read')).toThrow(
        AccessDeniedError,
      );
      expect(vault.loadIfActive('alice', clock)).toBeNull();
      clock = now + 5000;
      await flow.disconnect('alice');
      expect(flow.isConnected('alice')).toBe(false);
      vault.save('alice', 'old-token');
      provider.revoke.mockImplementationOnce(async () => {
        vault.save('alice', 'replacement-token');
      });
      await expect(flow.disconnect('alice')).rejects.toThrow('connection changed');
      expect(vault.load('alice')).toBe('replacement-token');
      expect(() => flow.forget('alice')).toThrow(AccessDeniedError);
      await flow.disconnect('alice');
      flow.forget('alice');
      expect(vault.load('alice')).toBeNull();
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('stores pending consent encrypted but denies processing and rejects denial during exchange', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-pending-consent-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    const provider = {
      authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
      exchange: vi.fn(async () => 'synthetic-refresh-token'),
      revoke: vi.fn(async (_token: string) => {}),
    };
    const flow = new GmailConsentFlow(states, access, vault, provider, () => now);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      const start = flow.start('alice');
      await flow.finish(
        'alice',
        new URL(start.location).searchParams.get('state')!,
        'code',
        start.cookie.split(';')[0],
      );
      expect(flow.isConnected('alice')).toBe(true);
      expect(() => vault.loadIfActive('alice', now)).toThrow(AccessDeniedError);
      expect(() => access.startProcessingWithConfirmation('alice', now, false)).toThrow(
        AccessDeniedError,
      );
      expect(readFileSync(path).includes(Buffer.from('synthetic-refresh-token'))).toBe(false);

      access.requestAccess('bob', 'bob@example.com', now);
      const bob = flow.start('bob');
      provider.exchange.mockImplementationOnce(async () => {
        access.deny('admin', 'bob', now);
        return 'bob-token';
      });
      await expect(
        flow.finish(
          'bob',
          new URL(bob.location).searchParams.get('state')!,
          'code',
          bob.cookie.split(';')[0],
        ),
      ).rejects.toThrow(AccessDeniedError);
      expect(vault.load('bob')).toBeNull();
      expect(() => flow.start('bob')).toThrow(AccessDeniedError);
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects stale callbacks after denial and re-request, forget, or a newer consent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-consent-fence-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    const provider = {
      authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
      exchange: vi.fn(async () => 'synthetic'),
      revoke: vi.fn(async (_token: string) => {}),
    };
    const flow = new GmailConsentFlow(states, access, vault, provider, () => now);
    try {
      access.bootstrapAdmin('admin');
      for (const operation of ['denial', 'forget', 'newer', 'disconnect'] as const) {
        const subject = `user-${operation}`;
        access.requestAccess(subject, `${subject}@example.com`, now);
        const start = flow.start(subject);
        provider.exchange.mockImplementationOnce(async () => {
          if (operation === 'denial') {
            access.deny('admin', subject, now);
            access.requestAccess(subject, `${subject}@example.com`, now);
          } else if (operation === 'forget') flow.forget(subject);
          else if (operation === 'newer') flow.start(subject);
          else await flow.disconnect(subject);
          return 'synthetic';
        });
        await expect(
          flow.finish(
            subject,
            new URL(start.location).searchParams.get('state')!,
            'code',
            start.cookie.split(';')[0],
          ),
        ).rejects.toThrow(AccessDeniedError);
        expect(vault.load(subject)).toBeNull();
      }
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('blocks reconnect and local removal during revocation and after failure until a retry succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-revoke-fence-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    const provider = {
      authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
      exchange: vi.fn(async () => 'synthetic'),
      revoke: vi.fn(async (_token: string) => {}),
    };
    const flow = new GmailConsentFlow(states, access, vault, provider, () => now);
    try {
      access.requestAccess('alice', 'alice@example.com', now);
      vault.save('alice', 'synthetic');
      provider.revoke.mockImplementationOnce(async () => {
        expect(() => flow.start('alice')).toThrow(AccessDeniedError);
        expect(() => flow.forget('alice')).toThrow(AccessDeniedError);
        await expect(flow.disconnect('alice')).rejects.toThrow(AccessDeniedError);
        throw new Error('provider failure');
      });
      await expect(flow.disconnect('alice')).rejects.toThrow('Gmail revocation failed');
      expect(() => flow.start('alice')).toThrow(AccessDeniedError);
      expect(() => flow.forget('alice')).toThrow(AccessDeniedError);
      await flow.disconnect('alice');
      expect(vault.has('alice')).toBe(false);
      expect(() => flow.start('alice')).not.toThrow();
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('stops processing atomically when a new Gmail connection is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-reconnect-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    const flow = new GmailConsentFlow(
      states,
      access,
      vault,
      {
        authorizationUrl: (state) => `https://accounts.google.com/example?state=${state}`,
        exchange: async () => 'new-token',
        revoke: async () => {},
      },
      () => now,
    );
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 60_000, 100, now);
      vault.save('alice', 'old-token');
      access.startProcessing('alice', now);
      const start = flow.start('alice');
      await flow.finish(
        'alice',
        new URL(start.location).searchParams.get('state')!,
        'code',
        start.cookie.split(';')[0],
      );
      expect(vault.loadIfActive('alice', now)).toBe('new-token');
      expect(access.processingRequested('alice')).toBe(false);
    } finally {
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
