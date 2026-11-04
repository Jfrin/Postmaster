import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { createBetaServer, type BetaSession } from '../src/beta/server.js';

const origin = 'https://beta.example.com';
const now = Date.parse('2026-11-04T10:00:00Z');
const csrf = 'z'.repeat(64);
const sessions: Record<string, BetaSession> = {
  admin: { subject: 'admin-sub', verifiedEmail: 'admin@example.com', csrfToken: csrf },
  alice: { subject: 'alice-sub', verifiedEmail: 'alice@example.com', csrfToken: csrf },
  bob: { subject: 'bob-sub', verifiedEmail: 'bob@example.com', csrfToken: csrf },
};
let store: BetaAccessStore;
let server: Server;
let base: string;

beforeEach(async () => {
  store = new BetaAccessStore(':memory:');
  store.bootstrapAdmin('admin-sub');
  server = createBetaServer({
    store,
    origin,
    now: () => now,
    authenticate: async (req: IncomingMessage) => {
      const cookie = req.headers.cookie?.replace(/^sid=/, '') ?? '';
      return sessions[cookie] ?? null;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

function request(
  path: string,
  who: string | null,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return new Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>(
    (resolve, reject) => {
      const req = httpRequest(
        `${base}${path}`,
        {
          method,
          headers: {
            Host: 'beta.example.com',
            ...(who ? { Cookie: `sid=${who}` } : {}),
            ...(method !== 'GET'
              ? { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }
              : {}),
            ...extra,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              text: async () => text,
              json: async () => JSON.parse(text) as unknown,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    },
  );
}

describe('unwired beta request and admin server', () => {
  it('denies missing sessions, spoofed identity headers, and invalid hosts', async () => {
    expect((await request('/', null)).status).toBe(401);
    expect(
      (await request('/api/session', null, 'GET', undefined, { 'X-Forwarded-User': 'admin-sub' }))
        .status,
    ).toBe(401);
    expect(
      (await request('/', 'admin', 'GET', undefined, { Host: 'evil.example.com' })).status,
    ).toBe(403);
    const html = await (await request('/', 'alice')).text();
    expect(html).toContain('Testing access');
    expect(html).toContain('including in dry run');
    expect(html).toContain('Processing may occur outside the VM');
    expect(html).toContain('Attachments are not sent');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!)).not.toThrow();
  });

  it('allows a user to request access only for their verified session identity', async () => {
    expect(
      (await request('/api/access/request', 'alice', 'POST', { subject: 'bob-sub' })).status,
    ).toBe(400);
    expect(store.ownRequest('bob-sub')).toBeNull();
    expect((await request('/api/access/request', 'alice', 'POST', {})).status).toBe(200);
    expect(store.ownRequest('alice-sub')).toMatchObject({
      email: 'alice@example.com',
      status: 'pending',
      dailyLimit: 100,
    });
    const self = (await (await request('/api/session', 'alice')).json()) as {
      isAdmin: boolean;
      request: { subject: string };
    };
    expect(self.isAdmin).toBe(false);
    expect(self.request.subject).toBe('alice-sub');
  });

  it('requires admin authorization, exact origin, and CSRF tokens for decisions', async () => {
    store.requestAccess('alice-sub', 'alice@example.com', now);
    const payload = { subject: 'alice-sub', expiresAt: now + 60_000, dailyLimit: 7 };
    expect((await request('/api/admin/requests', 'alice')).status).toBe(403);
    expect((await request('/api/admin/metrics', 'alice')).status).toBe(403);
    expect((await request('/api/admin/approve', 'alice', 'POST', payload)).status).toBe(403);
    expect(
      (
        await request('/api/admin/approve', 'admin', 'POST', payload, {
          Origin: 'https://evil.example.com',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/admin/approve', 'admin', 'POST', payload, { 'X-CSRF-Token': 'wrong' }))
        .status,
    ).toBe(403);
    expect(
      (
        await request('/api/admin/approve', 'admin', 'POST', payload, {
          'Content-Type': 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect(store.isActive('alice-sub', now)).toBe(false);
    expect((await request('/api/admin/approve', 'admin', 'POST', payload)).status).toBe(200);
    expect(store.isActive('alice-sub', now)).toBe(true);
    expect(store.reserveRead('alice-sub', now)).toBe(1);
    expect(await (await request('/api/admin/metrics', 'admin')).json()).toEqual({
      pending: 0,
      active: 1,
      expired: 0,
      denied: 0,
      readsToday: 1,
      cyclesToday: 0,
      processedToday: 0,
      failedToday: 0,
    });
    expect(await (await request('/api/admin/requests', 'admin')).json()).toMatchObject([
      { subject: 'alice-sub', dailyLimit: 7, attempts: 1 },
    ]);
    expect(
      (await request('/api/admin/deny', 'admin', 'POST', { subject: 'alice-sub' })).status,
    ).toBe(200);
    expect(store.isActive('alice-sub', now)).toBe(false);
  });

  it('validates approvals and does not expose Gmail or mutable configuration routes', async () => {
    store.requestAccess('alice-sub', 'alice@example.com', now);
    for (const body of [
      { subject: 'alice-sub', expiresAt: now, dailyLimit: 1 },
      { subject: 'alice-sub', expiresAt: now + 1, dailyLimit: -1 },
      { subject: 'alice-sub', expiresAt: now + 1, dailyLimit: 1, extra: true },
    ])
      expect((await request('/api/admin/approve', 'admin', 'POST', body)).status).toBe(400);
    expect((await request('/api/config', 'admin')).status).toBe(404);
    expect((await request('/api/control', 'admin', 'POST', {})).status).toBe(404);
    expect(
      (await request('/api/admin/deny', 'admin', 'POST', { subject: 'alice-sub', extra: true }))
        .status,
    ).toBe(400);
  });
});
