import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it } from 'vitest';
import { MockClassifier } from '../src/classifier.js';
import { parseConfig } from '../src/config.js';
import { BetaAccessStore } from '../src/beta/access.js';
import { createBetaRuntime } from '../src/beta/runtime.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const origin = 'https://beta.example.com';

function send(
  base: string,
  path: string,
  cookie: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
  raw = false,
  extra: Record<string, string> = {},
) {
  const route =
    raw ||
    path.startsWith('/auth/google/callback') ||
    path.startsWith('/auth/google/gmail/callback')
      ? path
      : `/beta${path}`;
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        base + route,
        {
          method,
          headers: {
            Host: 'beta.example.com',
            Cookie: cookie,
            ...(method !== 'GET'
              ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' }
              : {}),
            ...extra,
          },
        },
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
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    },
  );
}

function fakeGmail(subject: string, modified: string[]): gmail_v1.Gmail {
  const config = parseConfig(readFileSync('config/categories.default.yaml', 'utf8'));
  return {
    users: {
      getProfile: async () => ({ data: { historyId: '100' } }),
      labels: {
        list: async () => ({
          data: {
            labels: [
              ...config.categories.map((category) => ({
                id: category.id,
                name: `${config.settings.label_prefix}${category.label}`,
              })),
              { id: 'content_filtered', name: `${config.settings.label_prefix}Content Filtered` },
            ],
          },
        }),
      },
      history: { list: async () => ({ data: { history: [] } }) },
      messages: {
        list: async () => ({ data: { messages: [{ id: 'one' }, { id: 'two' }] } }),
        get: async ({ id }: { id: string }) => ({
          data: {
            threadId: id,
            labelIds: ['INBOX', 'UNREAD'],
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: `${subject}@example.com` },
                { name: 'Subject', value: `${subject} synthetic message` },
              ],
              body: { data: Buffer.from('Synthetic test email').toString('base64url') },
            },
          },
        }),
        modify: async ({ id }: { id: string }) => {
          modified.push(id);
          return { data: {} };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

describe('simulated two-user beta integration', () => {
  it('isolates requests, consent, settings, processing and admin metrics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-beta-integration-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const defaults = readFileSync('config/categories.default.yaml', 'utf8');
    const modifications: Record<string, string[]> = { alice: [], bob: [] };
    const gmailServices: string[] = [];
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    access.bootstrapAdmin('admin');
    const runtime = createBetaRuntime({
      databasePath: path,
      vaultKey: key,
      defaultConfigYaml: defaults,
      origin,
      basePath: '/beta',
      now: () => now,
      tickMs: 60_000,
      identityProvider: {
        authorizationUrl: (state: string) => `https://accounts.google.com/login?state=${state}`,
        exchange: async (code: string) => ({ subject: code, verifiedEmail: `${code}@example.com` }),
      },
      gmailConsentProvider: {
        authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
        exchange: async (_code: string, _verifier: string, _nonce: string, subject: string) =>
          `synthetic-${subject}-token`,
        revoke: async () => {},
      },
      makeGmailService: (subject, token) => {
        gmailServices.push(subject);
        expect(token).toBe(`synthetic-${subject}-token`);
        return { service: fakeGmail(subject, modifications[subject]!) };
      },
      classifier: new MockClassifier(),
    });
    const cookies: Record<string, string> = {};
    const csrf: Record<string, string> = {};
    try {
      await runtime.start();
      const base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
      expect((await send(base, '/api/session', '', 'GET', undefined, undefined, true)).status).toBe(
        404,
      );
      for (const subject of ['admin', 'alice', 'bob']) {
        const login = await send(base, '/auth/google/start', '');
        const state = new URL(login.headers.location!).searchParams.get('state')!;
        const loginCookie = login.headers['set-cookie']![0]!.split(';')[0]!;
        const callback = await send(
          base,
          `/auth/google/callback?state=${state}&code=${subject}`,
          loginCookie,
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.location).toBe('/beta/');
        cookies[subject] = callback.headers['set-cookie']![1]!.split(';')[0]!;
        csrf[subject] = (
          JSON.parse((await send(base, '/api/session', cookies[subject]!)).body) as {
            csrfToken: string;
          }
        ).csrfToken;
      }
      const page = await send(base, '/', cookies.alice!);
      expect(page.status).toBe(200);
      expect(page.body).toContain('const basePath="/beta"');
      for (const subject of ['alice', 'bob']) {
        const connect = await send(
          base,
          '/api/gmail/connect',
          cookies[subject]!,
          'POST',
          {},
          csrf[subject],
        );
        expect(connect.status).toBe(200);
        const state = new URL(
          (JSON.parse(connect.body) as { location: string }).location,
        ).searchParams.get('state')!;
        const stateCookie = connect.headers['set-cookie']![0]!.split(';')[0]!;
        expect(
          (
            await send(
              base,
              `/auth/google/gmail/callback?state=${state}&code=synthetic`,
              `${cookies[subject]}; ${stateCookie}`,
            )
          ).status,
        ).toBe(302);
        expect(access.ownRequest(subject)?.status).toBe('pending');
        expect(() => vault.loadIfActive(subject, now)).toThrow();
        expect((await send(base, '/api/config', cookies[subject]!)).status).toBe(403);
        expect((await send(base, '/api/processing/events', cookies[subject]!)).status).toBe(403);
        expect(
          (await send(base, '/api/processing/start', cookies[subject]!, 'POST', {}, csrf[subject]))
            .status,
        ).toBe(403);
      }
      await runtime.scheduler.tick();
      expect(gmailServices).toEqual([]);
      expect(modifications).toEqual({ alice: [], bob: [] });
      expect((await send(base, '/api/admin/requests', cookies.alice!)).status).toBe(403);
      const requests = JSON.parse(
        (await send(base, '/api/admin/requests', cookies.admin!)).body,
      ) as unknown[];
      expect(requests).toHaveLength(2);
      for (const subject of ['alice', 'bob']) {
        const approve = {
          subject,
          expiresAt: now + 60_000,
          dailyLimit: subject === 'alice' ? 1 : 2,
        };
        expect(
          (await send(base, '/api/admin/approve', cookies.admin!, 'POST', approve, csrf.admin))
            .status,
        ).toBe(200);
      }
      await runtime.scheduler.tick();
      expect(gmailServices).toEqual([]);
      for (const subject of ['alice', 'bob']) {
        expect(
          (await send(base, '/api/processing/start', cookies[subject]!, 'POST', {}, csrf[subject]))
            .status,
        ).toBe(200);
      }
      await runtime.scheduler.tick();
      await runtime.scheduler.tick();
      const aliceRows = JSON.parse((await send(base, '/api/activity', cookies.alice!)).body) as {
        subject: string;
      }[];
      const bobRows = JSON.parse(
        (await send(base, '/api/activity?subject=alice', cookies.bob!)).body,
      ) as { subject: string }[];
      expect(aliceRows).toHaveLength(1);
      expect(aliceRows[0]!.subject).toContain('alice');
      expect(bobRows).toHaveLength(2);
      expect(bobRows.every((row) => row.subject.includes('bob'))).toBe(true);
      const aliceEvents = JSON.parse(
        (await send(base, '/api/processing/events', cookies.alice!)).body,
      ) as { event: string }[];
      const bobEvents = JSON.parse(
        (await send(base, '/api/processing/events?subject=alice', cookies.bob!)).body,
      ) as { event: string; processed: number | null }[];
      expect(aliceEvents.some((event) => event.event === 'cycle_started')).toBe(true);
      expect(
        bobEvents.some((event) => event.event === 'cycle_completed' && event.processed === 2),
      ).toBe(true);
      const metrics = JSON.parse((await send(base, '/api/admin/metrics', cookies.admin!)).body) as {
        readsToday: number;
        processedToday: number;
      };
      expect(metrics.readsToday).toBe(3);
      expect(metrics.processedToday).toBe(3);
      expect(modifications).toEqual({ alice: [], bob: [] });
      expect(
        (await send(base, '/api/processing/stop', cookies.bob!, 'POST', {}, csrf.bob)).status,
      ).toBe(200);
      expect(
        (
          await send(
            base,
            '/api/admin/approve',
            cookies.admin!,
            'POST',
            { subject: 'bob', expiresAt: now + 60_000, dailyLimit: 4 },
            csrf.admin,
          )
        ).status,
      ).toBe(200);
      const bobConfig = JSON.parse((await send(base, '/api/config', cookies.bob!)).body) as {
        settings: { dry_run: boolean };
      };
      bobConfig.settings.dry_run = false;
      expect(
        (await send(base, '/api/config', cookies.bob!, 'PUT', bobConfig, csrf.bob)).status,
      ).toBe(409);
      expect(
        (
          await send(base, '/api/config', cookies.bob!, 'PUT', bobConfig, csrf.bob, false, {
            'X-Confirm-Live': 'yes',
          })
        ).status,
      ).toBe(200);
      expect(
        (await send(base, '/api/processing/start', cookies.bob!, 'POST', {}, csrf.bob)).status,
      ).toBe(409);
      expect(
        (
          await send(
            base,
            '/api/processing/start',
            cookies.bob!,
            'POST',
            { confirmLive: true },
            csrf.bob,
          )
        ).status,
      ).toBe(200);
      await runtime.scheduler.tick();
      expect(modifications.alice).toEqual([]);
      expect(modifications.bob).toEqual(['one', 'two']);
      expect(
        (
          await send(
            base,
            '/api/admin/deny',
            cookies.admin!,
            'POST',
            { subject: 'bob' },
            csrf.admin,
          )
        ).status,
      ).toBe(200);
      expect((await send(base, '/api/activity', cookies.bob!)).status).toBe(403);
      expect((await send(base, '/api/processing/events', cookies.bob!)).status).toBe(403);
      expect(access.processingRequested('bob')).toBe(false);
      expect(vault.load('bob')).toBe('synthetic-bob-token');
    } finally {
      await runtime.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
