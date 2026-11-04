import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it } from 'vitest';
import { MockClassifier } from '../src/classifier.js';
import { BetaAccessStore } from '../src/beta/access.js';
import { BetaActivityStore } from '../src/beta/activity.js';
import { GmailConsentFlow } from '../src/beta/gmail-consent-flow.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import { BetaScheduler } from '../src/beta/scheduler.js';
import { createBetaServer } from '../src/beta/server.js';
import { BetaSessionStore } from '../src/beta/session-store.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { BetaUserConfigStore } from '../src/beta/user-config.js';
import { BetaCycleRunner } from '../src/beta/worker.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const origin = 'https://beta.example.com';

function send(
  base: string,
  path: string,
  cookie: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        base + path,
        {
          method,
          headers: {
            Host: 'beta.example.com',
            Cookie: cookie,
            ...(method !== 'GET'
              ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' }
              : {}),
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

function fakeGmail(subject: string): gmail_v1.Gmail {
  return {
    users: {
      getProfile: async () => ({ data: { historyId: '100' } }),
      labels: { list: async () => ({ data: { labels: [] } }) },
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
        modify: async () => {
          throw new Error('dry run must not modify Gmail');
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
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    const config = new BetaUserConfigStore(path, defaults);
    const activity = new BetaActivityStore(path);
    const sessions = new BetaSessionStore(path);
    const states = new GmailConsentStateStore(path);
    const consent = new GmailConsentFlow(
      states,
      access,
      vault,
      {
        authorizationUrl: (state: string) => `https://accounts.google.com/example?state=${state}`,
        exchange: async (_code: string, _verifier: string, _nonce: string, subject: string) =>
          `synthetic-${subject}-token`,
        revoke: async () => {},
      },
      () => now,
    );
    const runner = new BetaCycleRunner({
      databasePath: path,
      vaultKey: key,
      defaultConfigYaml: defaults,
      makeGmailService: (subject, token) => {
        expect(token).toBe(`synthetic-${subject}-token`);
        return fakeGmail(subject);
      },
      classifier: new MockClassifier(),
      now: () => new Date(now),
    });
    const scheduler = new BetaScheduler(access, runner, () => now, 1, 60_000);
    access.bootstrapAdmin('admin');
    scheduler.start();
    const server: Server = createBetaServer({
      store: access,
      origin,
      now: () => now,
      userConfigStore: config,
      activityStore: activity,
      gmailConsentFlow: consent,
      processingOnline: () => scheduler.status().online,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookies: Record<string, string> = {};
    const csrf: Record<string, string> = {};
    try {
      for (const subject of ['admin', 'alice', 'bob']) {
        cookies[subject] = sessions
          .issue(subject, `${subject}@example.com`, now, 60_000)
          .split(';')[0]!;
        csrf[subject] = (
          JSON.parse((await send(base, '/api/session', cookies[subject]!)).body) as {
            csrfToken: string;
          }
        ).csrfToken;
      }
      for (const subject of ['alice', 'bob']) {
        expect(
          (await send(base, '/api/access/request', cookies[subject]!, 'POST', {}, csrf[subject]))
            .status,
        ).toBe(200);
      }
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
        expect(
          (await send(base, '/api/processing/start', cookies[subject]!, 'POST', {}, csrf[subject]))
            .status,
        ).toBe(200);
      }
      await scheduler.tick();
      await scheduler.tick();
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
      const metrics = JSON.parse((await send(base, '/api/admin/metrics', cookies.admin!)).body) as {
        readsToday: number;
        processedToday: number;
      };
      expect(metrics.readsToday).toBe(3);
      expect(metrics.processedToday).toBe(3);
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
      expect(access.processingRequested('bob')).toBe(false);
      expect(vault.load('bob')).toBe('synthetic-bob-token');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await scheduler.stop();
      runner.close();
      states.close();
      sessions.close();
      activity.close();
      config.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
