import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { BetaAccessStore } from '../src/beta/access.js';
import { createBetaServer } from '../src/beta/server.js';
import { BetaSessionStore } from '../src/beta/session-store.js';
import { BetaUserConfigStore } from '../src/beta/user-config.js';

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

describe('per-user config API prototype', () => {
  it('derives the owner from the session and isolates two users', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-config-http-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const config = new BetaUserConfigStore(
      path,
      readFileSync('config/categories.default.yaml', 'utf8'),
    );
    const sessions = new BetaSessionStore(path);
    access.bootstrapAdmin('admin');
    for (const subject of ['alice', 'bob']) {
      access.requestAccess(subject, `${subject}@example.com`, now);
      access.approve('admin', subject, now + 60_000, 100, now);
    }
    access.requestAccess('pending', 'pending@example.com', now);
    const server: Server = createBetaServer({
      store: access,
      origin,
      now: () => now,
      userConfigStore: config,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const alice = sessions.issue('alice', 'alice@example.com', now, 60_000).split(';')[0]!;
    const bob = sessions.issue('bob', 'bob@example.com', now, 60_000).split(';')[0]!;
    const pending = sessions.issue('pending', 'pending@example.com', now, 60_000).split(';')[0]!;
    try {
      const aliceSession = JSON.parse((await send(base, '/api/session', alice)).body) as {
        csrfToken: string;
      };
      const originalBob = JSON.parse((await send(base, '/api/config', bob)).body) as Config;
      const originalAlice = JSON.parse(
        (await send(base, '/api/config?subject=bob', alice)).body,
      ) as Config;
      originalAlice.settings.label_prefix = 'ALICE/';
      expect((await send(base, '/api/config', alice, 'PUT', originalAlice, 'wrong')).status).toBe(
        403,
      );
      expect(
        (await send(base, '/api/config', alice, 'PUT', originalAlice, aliceSession.csrfToken))
          .status,
      ).toBe(200);
      expect(JSON.parse((await send(base, '/api/config', bob)).body)).toEqual(originalBob);
      expect(
        (JSON.parse((await send(base, '/api/config', alice)).body) as Config).settings.label_prefix,
      ).toBe('ALICE/');
      expect((await send(base, '/api/config', pending)).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sessions.close();
      config.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
