import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { IdentityFlow } from '../src/beta/identity-flow.js';
import { IdentityLoginStateStore } from '../src/beta/oauth-state.js';
import { createBetaServer } from '../src/beta/server.js';
import { BetaSessionStore } from '../src/beta/session-store.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const origin = 'https://beta.example.com';

async function send(
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

describe('identity login integration with a simulated Google provider', () => {
  it('requires browser-bound one-time state, creates a session, and CSRF-protects logout', async () => {
    const access = new BetaAccessStore(':memory:');
    access.bootstrapAdmin('admin-sub');
    const states = new IdentityLoginStateStore(':memory:');
    const sessions = new BetaSessionStore(':memory:');
    let savedNonce = '';
    const provider = {
      authorizationUrl: vi.fn((state: string, nonce: string, challenge: string) => {
        savedNonce = nonce;
        return `https://accounts.google.com/example?state=${state}&code_challenge=${challenge}`;
      }),
      exchange: vi.fn(async (code: string, verifier: string, nonce: string) => {
        expect(code).toBe('synthetic-code');
        expect(verifier.length).toBeGreaterThan(43);
        expect(nonce).toBe(savedNonce);
        return { subject: 'user-sub', verifiedEmail: 'user@example.com' };
      }),
    };
    const flow = new IdentityFlow(states, sessions, provider);
    const server: Server = createBetaServer({
      store: access,
      origin,
      now: () => now,
      identityFlow: flow,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const root = await send(base, '/');
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe('/auth/google/start');
      const start = await send(base, root.headers.location!);
      expect(start.status).toBe(302);
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const stateCookie = start.headers['set-cookie']![0]!.split(';')[0]!;
      const callback = `/auth/google/callback?state=${state}&code=synthetic-code`;
      expect((await send(base, callback)).status).toBe(401);
      const complete = await send(base, callback, 'GET', { Cookie: stateCookie });
      expect(complete.status).toBe(302);
      expect(complete.headers.location).toBe('/');
      const sessionCookie = complete.headers['set-cookie']!.find((x) =>
        x.startsWith('__Host-postmaster_session='),
      )!.split(';')[0]!;
      expect((await send(base, callback, 'GET', { Cookie: stateCookie })).status).toBe(401);
      expect(provider.exchange).toHaveBeenCalledTimes(1);
      const self = await send(base, '/api/session', 'GET', { Cookie: sessionCookie });
      expect(self.status).toBe(200);
      const session = JSON.parse(self.body) as { csrfToken: string; isAdmin: boolean };
      expect(session.isAdmin).toBe(false);
      const mutate = {
        Cookie: sessionCookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
      };
      expect((await send(base, '/api/access/request', 'POST', mutate, '{}')).status).toBe(200);
      expect(access.ownRequest('user-sub')?.status).toBe('pending');
      expect(
        (await send(base, '/api/logout', 'POST', { ...mutate, 'X-CSRF-Token': 'wrong' }, '{}'))
          .status,
      ).toBe(403);
      expect((await send(base, '/api/logout', 'POST', mutate, '{}')).status).toBe(200);
      expect((await send(base, '/api/session', 'GET', { Cookie: sessionCookie })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sessions.close();
      states.close();
      access.close();
    }
  });
});
