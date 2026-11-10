import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import {
  IdentityAccessDeniedError,
  IdentityFlow,
  restrictIdentityProvider,
} from '../src/beta/identity-flow.js';
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
  it('serves public navigation and a sign-in page while keeping admin private', async () => {
    const access = new BetaAccessStore(':memory:');
    const states = new IdentityLoginStateStore(':memory:');
    const sessions = new BetaSessionStore(':memory:');
    const flow = new IdentityFlow(states, sessions, {
      authorizationUrl: (state) => `https://accounts.google.com/?state=${state}`,
      exchange: async () => {
        throw new IdentityAccessDeniedError('private identity details');
      },
    });
    const server = createBetaServer({
      store: access,
      origin,
      basePath: '/beta',
      now: () => now,
      identityFlow: flow,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const landing = await send(base, '/');
      expect(landing.status).toBe(200);
      for (const href of ['/beta/apply', '/beta', '/demo', '/privacy', '/terms'])
        expect(landing.body).toContain(`href="${href}"`);
      expect(landing.body).not.toContain('/beta/admin');
      expect(landing.body).toContain('Azure OpenAI');
      expect(landing.body).toContain('Gmail and Google Workspace accounts');
      expect(landing.body).toContain('Other email providers are not supported');
      expect(landing.body).toContain('Dry run records decisions without changing Gmail');
      expect(landing.body).toContain('does not connect to Gmail or use Azure OpenAI');
      const privacy = await send(base, '/privacy');
      expect(privacy.status).toBe(200);
      expect(privacy.headers['content-type']).toContain('text/html');
      expect(privacy.body).toContain('Postmaster privacy policy');
      expect(privacy.body).toContain('Jose Andres Ofrin');
      expect(privacy.body).toContain('Azure OpenAI');
      expect(privacy.body).toContain('does not revoke access at Google');
      expect(privacy.body).toContain('href="/terms"');
      expect(privacy.body).toContain('<main class="document">');
      expect(privacy.body).toContain('aria-label="Legal"');
      const terms = await send(base, '/terms');
      expect(terms.status).toBe(200);
      expect(terms.headers['content-type']).toContain('text/html');
      expect(terms.body).toContain('Postmaster terms of service');
      expect(terms.body).toContain('<span class="eyebrow">Terms of Service</span>');
      expect(terms.body).toContain('Jose Andres Ofrin');
      expect(terms.body).toContain('Philippines');
      expect(terms.body).toContain('href="/privacy"');
      expect(terms.body).toContain('<main class="document">');
      const login = await send(base, '/beta');
      expect(login.status).toBe(200);
      expect(login.body).toContain('href="/beta/auth/google/start"');
      expect(login.body).toContain('Signing in does not connect Gmail or start processing');
      expect(login.body).toContain('Live actions require confirmation');
      expect(login.body).toContain('href="/beta/apply"');
      expect(login.body).toContain('href="/privacy"');
      expect(login.body).toContain('href="/terms"');
      expect((await send(base, '/beta/apply')).body).toContain('href="/privacy"');
      expect((await send(base, '/beta/apply')).body).toContain('href="/terms"');
      const admin = await send(base, '/beta/admin');
      expect(admin.status).toBe(401);
      expect(admin.headers['content-type']).toContain('text/html');
      expect(admin.body).toContain('href="/beta/"');
      expect(admin.body).toContain('href="/">Home');
      expect((await send(base, '/beta/api/admin/applications')).status).toBe(401);
      const start = await send(base, '/beta/auth/google/start');
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const cookie = start.headers['set-cookie']![0]!.split(';')[0]!;
      const rejected = await send(
        base,
        `/auth/google/callback?state=${state}&code=synthetic`,
        'GET',
        { Cookie: cookie },
      );
      expect(rejected.status).toBe(401);
      expect(rejected.body).toContain('not approved for beta access');
      expect(rejected.body).not.toContain('private identity details');
      const cancelled = await send(base, '/auth/google/callback?error=access_denied');
      expect(cancelled.status).toBe(400);
      expect(cancelled.body).toContain('cancelled');
      expect(cancelled.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sessions.close();
      states.close();
      access.close();
    }
  });
  it('restricts an owner-only test to the verified owner subject', async () => {
    const provider = {
      authorizationUrl: () => 'https://example.com/',
      exchange: async (code: string) => ({ subject: code, verifiedEmail: 'synthetic@example.com' }),
    };
    const restricted = restrictIdentityProvider(provider, 'owner');
    await expect(restricted.exchange('owner', 'verifier', 'nonce')).resolves.toMatchObject({
      subject: 'owner',
    });
    await expect(restricted.exchange('other', 'verifier', 'nonce')).rejects.toThrow(
      'identity is not permitted',
    );
  });
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
      expect(root.status).toBe(200);
      expect(root.body).toContain('href="/auth/google/start"');
      const start = await send(base, '/auth/google/start');
      expect(start.status).toBe(302);
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const stateCookie = start.headers['set-cookie']![0]!.split(';')[0]!;
      const callback = `/auth/google/callback?state=${state}&code=synthetic-code`;
      const noCookie = await send(base, callback);
      expect(noCookie.status).toBe(401);
      expect(noCookie.body).toContain('browser cookie was missing');
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
