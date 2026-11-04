import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { GmailConsentFlow } from '../src/beta/gmail-consent-flow.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import { createBetaServer } from '../src/beta/server.js';
import { BetaSessionStore } from '../src/beta/session-store.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const origin = 'https://beta.example.com';

function send(
  base: string,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        base + path,
        { method, headers: { Host: 'beta.example.com', ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    },
  );
}

describe('simulated Gmail consent through the beta server', () => {
  it('requires approval, a CSRF-protected start, and the same user on callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-consent-http-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const states = new GmailConsentStateStore(path);
    const sessions = new BetaSessionStore(path);
    access.bootstrapAdmin('admin');
    access.requestAccess('alice', 'alice@example.com', now);
    access.approve('admin', 'alice', now + 60_000, 100, now);
    access.requestAccess('bob', 'bob@example.com', now);
    const provider = {
      authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
      exchange: async (_code: string, _verifier: string, _nonce: string, subject: string) => {
        expect(subject).toBe('alice');
        return 'synthetic-refresh-token';
      },
      revoke: async (_token: string) => {},
    };
    const flow = new GmailConsentFlow(states, access, vault, provider, () => now);
    const server: Server = createBetaServer({
      store: access,
      origin,
      now: () => now,
      gmailConsentFlow: flow,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const alice = sessions.issue('alice', 'alice@example.com', now, 60_000).split(';')[0]!;
    const bob = sessions.issue('bob', 'bob@example.com', now, 60_000).split(';')[0]!;
    try {
      const self = JSON.parse(
        (await send(base, '/api/session', 'GET', { Cookie: alice })).body,
      ) as { csrfToken: string; gmailConnected: boolean };
      expect(self.gmailConnected).toBe(false);
      const allowed = {
        Cookie: alice,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': self.csrfToken,
      };
      expect(
        (
          await send(
            base,
            '/api/gmail/connect',
            'POST',
            { ...allowed, 'X-CSRF-Token': 'bad' },
            '{}',
          )
        ).status,
      ).toBe(403);
      const bobSession = JSON.parse(
        (await send(base, '/api/session', 'GET', { Cookie: bob })).body,
      ) as { csrfToken: string };
      expect(
        (
          await send(
            base,
            '/api/gmail/connect',
            'POST',
            { ...allowed, Cookie: bob, 'X-CSRF-Token': bobSession.csrfToken },
            '{}',
          )
        ).status,
      ).toBe(403);
      const start = await send(base, '/api/gmail/connect', 'POST', allowed, '{}');
      expect(start.status).toBe(200);
      const state = new URL(
        (JSON.parse(start.body) as { location: string }).location,
      ).searchParams.get('state')!;
      const stateCookie = start.headers['set-cookie']![0]!.split(';')[0]!;
      const callback = `/auth/google/gmail/callback?state=${state}&code=synthetic-code`;
      expect((await send(base, callback, 'GET', { Cookie: `${bob}; ${stateCookie}` })).status).toBe(
        403,
      );
      expect(
        (await send(base, callback, 'GET', { Cookie: `${alice}; ${stateCookie}` })).status,
      ).toBe(302);
      expect(vault.loadIfActive('alice', now)).toBe('synthetic-refresh-token');
      expect(vault.load('bob')).toBeNull();
      const connected = JSON.parse(
        (await send(base, '/api/session', 'GET', { Cookie: alice })).body,
      ) as { gmailConnected: boolean };
      expect(connected.gmailConnected).toBe(true);
      expect(
        (await send(base, callback, 'GET', { Cookie: `${alice}; ${stateCookie}` })).status,
      ).toBe(403);
      expect(
        (
          await send(
            base,
            '/api/gmail/disconnect',
            'POST',
            { ...allowed, 'X-CSRF-Token': 'bad' },
            '{}',
          )
        ).status,
      ).toBe(403);
      expect((await send(base, '/api/gmail/disconnect', 'POST', allowed, '{}')).status).toBe(200);
      expect(vault.load('alice')).toBeNull();
      vault.save('alice', 'synthetic-alice-token');
      vault.save('bob', 'synthetic-bob-token');
      const bobHeaders = { ...allowed, Cookie: bob, 'X-CSRF-Token': bobSession.csrfToken };
      expect((await send(base, '/api/gmail/forget', 'POST', bobHeaders, '{}')).status).toBe(200);
      expect(vault.load('bob')).toBeNull();
      expect(vault.load('alice')).toBe('synthetic-alice-token');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sessions.close();
      states.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
