import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { BetaActivityStore } from '../src/beta/activity.js';
import { BetaDataPrivacy, privateStateIdentifiers } from '../src/beta/data-privacy.js';
import { GmailConsentFlow } from '../src/beta/gmail-consent-flow.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import { BetaProcessingEvents } from '../src/beta/processing-events.js';
import { createBetaServer } from '../src/beta/server.js';
import { BetaSessionStore } from '../src/beta/session-store.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { BetaUserConfigStore } from '../src/beta/user-config.js';
import { State } from '../src/state.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const origin = 'https://beta.example.com';

function send(
  base: string,
  path: string,
  cookie: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
  extra: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
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
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('beta processing controls and activity prototype', () => {
  it('isolates activity and requires explicit, CSRF-protected live-mode confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-processing-http-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const key = randomBytes(32);
    const vault = new GmailTokenVault(path, key);
    const config = new BetaUserConfigStore(
      path,
      readFileSync('config/categories.default.yaml', 'utf8'),
    );
    const activity = new BetaActivityStore(path);
    const sessions = new BetaSessionStore(path);
    const consent = new GmailConsentStateStore(path);
    const events = new BetaProcessingEvents(path);
    const privacy = new BetaDataPrivacy(path, key, now);
    let revokeFails = true;
    const revoked: string[] = [];
    const gmail = new GmailConsentFlow(
      consent,
      access,
      vault,
      {
        authorizationUrl: () => 'https://example.com',
        exchange: async () => 'unused',
        revoke: async (token) => {
          if (revokeFails) throw new Error('synthetic provider failure');
          revoked.push(token);
        },
      },
      () => now,
    );
    access.bootstrapAdmin('admin');
    for (const subject of ['alice', 'bob']) {
      access.requestAccess(subject, `${subject}@example.com`, now);
      access.approve('admin', subject, now + 60_000, 100, now);
      vault.save(subject, `synthetic-${subject}-token`);
    }
    const aliceState = new State(path, 'alice', undefined, privateStateIdentifiers(key, 'alice'));
    aliceState.recordDecision(
      'alice-message',
      { category: 'needs_review', confidence: 1, source: 'rule', reason: 'synthetic' },
      false,
      new Date(now),
      { subject: 'Alice only' },
    );
    aliceState.close();
    let online = true;
    const server: Server = createBetaServer({
      store: access,
      origin,
      now: () => now,
      userConfigStore: config,
      activityStore: activity,
      dataPrivacy: privacy,
      gmailConsentFlow: gmail,
      processingOnline: () => online,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const alice = sessions.issue('alice', 'alice@example.com', now, 60_000).split(';')[0]!;
    const bob = sessions.issue('bob', 'bob@example.com', now, 60_000).split(';')[0]!;
    try {
      const aliceSession = JSON.parse((await send(base, '/api/session', alice)).body) as {
        csrfToken: string;
      };
      const aliceActivity = JSON.parse((await send(base, '/api/activity', alice)).body) as {
        subject: string;
      }[];
      expect(aliceActivity).toHaveLength(1);
      expect(aliceActivity[0]!.subject).toBe('Alice only');
      expect(JSON.parse((await send(base, '/api/activity?subject=alice', bob)).body)).toEqual([]);
      expect((await send(base, '/api/processing/start', alice, 'POST', {}, 'bad')).status).toBe(
        403,
      );
      expect(
        (await send(base, '/api/processing/start', alice, 'POST', {}, aliceSession.csrfToken))
          .status,
      ).toBe(200);
      expect(access.processingRequested('alice')).toBe(true);
      expect(access.processingRequested('bob')).toBe(false);
      online = false;
      expect(
        (await send(base, '/api/processing/stop', alice, 'POST', {}, aliceSession.csrfToken))
          .status,
      ).toBe(200);
      expect(access.processingRequested('alice')).toBe(false);
      online = true;
      const live = config.get('alice', now);
      live.settings.dry_run = false;
      expect(
        (await send(base, '/api/config', alice, 'PUT', live, aliceSession.csrfToken)).status,
      ).toBe(409);
      expect(config.get('alice', now).settings.dry_run).toBe(true);
      expect(
        (
          await send(base, '/api/config', alice, 'PUT', live, aliceSession.csrfToken, {
            'X-Confirm-Live': 'yes',
          })
        ).status,
      ).toBe(200);
      expect(
        (await send(base, '/api/processing/start', alice, 'POST', {}, aliceSession.csrfToken))
          .status,
      ).toBe(409);
      expect(access.processingRequested('alice')).toBe(false);
      expect(
        (
          await send(
            base,
            '/api/processing/start',
            alice,
            'POST',
            { confirmLive: true },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(200);
      access.stopProcessing('alice');
      online = false;
      expect(
        (
          await send(
            base,
            '/api/processing/start',
            alice,
            'POST',
            { confirmLive: true },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await send(
            base,
            '/api/data/delete',
            alice,
            'POST',
            { scope: 'all', confirm: true },
            'bad',
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            base,
            '/api/data/delete',
            alice,
            'POST',
            { scope: 'all', confirm: true, subject: 'bob' },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await send(
            base,
            '/api/data/delete',
            alice,
            'POST',
            { scope: 'content', confirm: true },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(200);
      expect(activity.recent('alice', now)[0]!.subject).toBeNull();
      expect(access.ownRequest('bob')).not.toBeNull();
      expect(
        (
          await send(
            base,
            '/api/data/delete',
            alice,
            'POST',
            { scope: 'all', confirm: true },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(200);
      expect((await send(base, '/api/session', alice)).status).toBe(200);
      expect(vault.has('alice')).toBe(true);
      expect(access.ownRequest('alice')).not.toBeNull();
      expect(
        (await send(base, '/api/account/delete', alice, 'POST', { confirm: true }, 'bad')).status,
      ).toBe(403);
      expect(
        (
          await send(
            base,
            '/api/account/delete',
            alice,
            'POST',
            { confirm: true, subject: 'bob' },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await send(
            base,
            '/api/account/delete',
            alice,
            'POST',
            { confirm: true },
            aliceSession.csrfToken,
          )
        ).status,
      ).toBe(503);
      expect(vault.has('alice')).toBe(true);
      expect(access.ownRequest('alice')).not.toBeNull();
      expect(access.processingRequested('alice')).toBe(false);
      revokeFails = false;
      const deleted = await send(
        base,
        '/api/account/delete',
        alice,
        'POST',
        { confirm: true },
        aliceSession.csrfToken,
      );
      expect(deleted.status).toBe(200);
      expect(JSON.parse(deleted.body)).toEqual({ ok: true, gmailRevocation: 'requested' });
      expect(revoked).toEqual(['synthetic-alice-token']);
      expect((await send(base, '/api/session', alice)).status).toBe(401);
      expect(access.ownRequest('alice')).toBeNull();
      expect(vault.has('alice')).toBe(false);
      expect(access.ownRequest('bob')).not.toBeNull();
      const bobSession = JSON.parse((await send(base, '/api/session', bob)).body) as {
        csrfToken: string;
      };
      vault.forgetConnection('bob');
      const noToken = await send(
        base,
        '/api/account/delete',
        bob,
        'POST',
        { confirm: true },
        bobSession.csrfToken,
      );
      expect(noToken.status).toBe(200);
      expect(JSON.parse(noToken.body)).toEqual({ ok: true, gmailRevocation: 'no-local-token' });
      expect(revoked).toEqual(['synthetic-alice-token']);
      expect((await send(base, '/api/session', bob)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      privacy.close();
      events.close();
      consent.close();
      sessions.close();
      activity.close();
      config.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
