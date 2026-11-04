import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { gmail as gmailApi } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailClient } from '../src/gmail.js';
import {
  AccessDeniedError,
  BetaAccessStore,
  DailyReadLimitError,
  LeaseLostError,
} from '../src/beta/access.js';
import { createLeasedBetaGmailGuard } from '../src/beta/gmail-guard.js';
import { BetaGmailOAuthClient } from '../src/beta/gmail-oauth-client.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { googleGmailServiceFactory } from '../src/beta/worker.js';

const fakeFetch = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fakeFetch }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const beforeMidnight = Date.parse('2026-11-04T23:59:59.500Z');

function fixture(limit = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'postmaster-dispatch-'));
  const path = join(dir, 'beta.db');
  const access = new BetaAccessStore(path);
  const vault = new GmailTokenVault(path, randomBytes(32));
  let time = beforeMidnight;
  access.bootstrapAdmin('admin');
  access.requestAccess('user', 'user@example.com', time);
  access.approve('admin', 'user', time + 60_000, limit, time);
  vault.save('user', 'synthetic-refresh');
  access.startProcessing('user', time);
  const lease = access.acquireLease('user', 'a'.repeat(32), time, 30_000)!;
  const guard = createLeasedBetaGmailGuard(access, lease, () => time);
  const auth = new BetaGmailOAuthClient({ clientId: 'fake', clientSecret: 'fake' });
  auth.setCredentials({ refresh_token: 'synthetic-refresh' });
  const original = auth.transporter.request.bind(auth.transporter);
  let release!: () => void;
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(auth.transporter, 'request').mockImplementation(((opts: { url?: string | URL }) => {
    if (new URL(String(opts.url)).hostname === 'oauth2.googleapis.com') {
      started();
      return resume.then(() => ({ data: { access_token: 'synthetic', expires_in: 3600 } }));
    }
    return original(opts);
  }) as never);
  const makeMail = () =>
    new GmailClient(gmailApi({ version: 'v1', auth }), guard, (kind, request) =>
      auth.execute(kind, guard, request),
    );
  return {
    access,
    path,
    vault,
    lease,
    auth,
    guard,
    makeMail,
    refreshing,
    release,
    setTime: (value: number) => {
      time = value;
    },
    close: () => {
      release();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    },
  };
}

afterEach(() => {
  fakeFetch.mockReset();
  vi.restoreAllMocks();
});

describe('beta Gmail OAuth dispatch', () => {
  it.each(['stop', 'denial', 'disconnect', 'expiry', 'lease loss', 'scheduler loss'] as const)(
    'blocks a message read when %s occurs during token refresh',
    async (reason) => {
      const f = fixture();
      try {
        const scheduler =
          reason === 'scheduler loss'
            ? f.access.acquireScheduler('s'.repeat(32), beforeMidnight, 1000)!
            : undefined;
        if (scheduler) {
          f.access.releaseLease(f.lease);
          f.access.startProcessing('user', beforeMidnight);
          Object.assign(
            f.lease,
            f.access.acquireLease('user', 'b'.repeat(32), beforeMidnight, 30_000, scheduler)!,
          );
        }
        const result = f.makeMail().fetchMessage('synthetic', 100);
        await f.refreshing;
        if (reason === 'stop') f.access.stopProcessing('user');
        if (reason === 'denial') f.access.deny('admin', 'user', beforeMidnight);
        if (reason === 'disconnect') f.vault.disableAndLoad('user');
        if (reason === 'expiry') f.setTime(beforeMidnight + 60_000);
        if (reason === 'lease loss') f.access.releaseLease(f.lease);
        if (reason === 'scheduler loss') f.setTime(beforeMidnight + 1000);
        f.release();
        await expect(result).rejects.toSatisfy(
          (e: unknown) => e instanceof AccessDeniedError || e instanceof LeaseLostError,
        );
        expect(fakeFetch).not.toHaveBeenCalled();
        expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(0);
      } finally {
        f.close();
      }
    },
  );

  it('charges the day when fetch is invoked, not the day when refresh started', async () => {
    const f = fixture();
    try {
      fakeFetch.mockResolvedValue(
        new Response(JSON.stringify({ id: 'synthetic' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const result = f.makeMail().fetchMessage('synthetic', 100);
      await f.refreshing;
      f.setTime(beforeMidnight + 500);
      f.release();
      await result;
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(0);
      expect(f.access.readUsage('admin', 'user', beforeMidnight + 500).attempts).toBe(1);
    } finally {
      f.close();
    }
  });

  it.each([401, 403])(
    'counts failed HTTP %s requests and explicit retries once each, and blocks at the limit',
    async (status) => {
      const f = fixture(2);
      try {
        fakeFetch.mockImplementation(() =>
          Promise.resolve(
            new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
          ),
        );
        const first = f.makeMail().fetchMessage('synthetic', 100);
        await f.refreshing;
        f.release();
        await expect(first).rejects.toThrow();
        await expect(f.makeMail().fetchMessage('synthetic', 100)).rejects.toThrow();
        await expect(f.makeMail().fetchMessage('synthetic', 100)).rejects.toBeInstanceOf(
          DailyReadLimitError,
        );
        expect(fakeFetch).toHaveBeenCalledTimes(2);
        expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(2);
      } finally {
        f.close();
      }
    },
  );

  it('rechecks the daily limit after refresh rather than reserving a read early', async () => {
    const f = fixture(1);
    try {
      const result = f.makeMail().fetchMessage('synthetic', 100);
      await f.refreshing;
      f.guard('message_read');
      f.release();
      await expect(result).rejects.toBeInstanceOf(DailyReadLimitError);
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(1);
    } finally {
      f.close();
    }
  });

  it('does not count or dispatch a Gmail read if the OAuth refresh fails', async () => {
    const f = fixture();
    try {
      vi.mocked(f.auth.transporter.request).mockRejectedValue(
        new Error('synthetic refresh failure'),
      );
      await expect(f.makeMail().fetchMessage('synthetic', 100)).rejects.toThrow(
        'synthetic refresh failure',
      );
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(0);
    } finally {
      f.close();
    }
  });

  it('also fences a Gmail modification after refresh', async () => {
    const f = fixture();
    try {
      const result = f.makeMail().modify('synthetic', { add: ['label'], remove: [] });
      await f.refreshing;
      f.access.stopProcessing('user');
      f.release();
      await expect(result).rejects.toBeInstanceOf(AccessDeniedError);
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(0);
    } finally {
      f.close();
    }
  });

  it.each([1, 2])('fails closed if midnight passes during authorization, sample %s', async (at) => {
    const f = fixture();
    try {
      let samples = 0;
      const guard = () =>
        f.access.authorizeLeasedGmailAttempt(
          f.lease,
          () => (samples++ < at ? beforeMidnight : beforeMidnight + 500),
          'message_read',
        );
      const mail = new GmailClient(
        gmailApi({ version: 'v1', auth: f.auth }),
        guard,
        (kind, request) => f.auth.execute(kind, guard, request),
      );
      const result = mail.fetchMessage('synthetic', 100);
      await f.refreshing;
      f.release();
      await expect(result).rejects.toThrow('UTC day changed during Gmail authorization');
      expect(fakeFetch).not.toHaveBeenCalled();
      // Conservative reservation: no network call was made, but the earlier day remains charged.
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(1);
      expect(f.access.readUsage('admin', 'user', beforeMidnight + 500).attempts).toBe(0);
    } finally {
      f.close();
    }
  });

  it('samples the authorization clock after acquiring the SQLite write lock', () => {
    const f = fixture();
    const other = new DatabaseSync(f.path);
    try {
      other.exec('PRAGMA busy_timeout = 0');
      let samples = 0;
      f.access.authorizeLeasedGmailAttempt(
        f.lease,
        () => {
          if (samples++ === 0) expect(() => other.exec('BEGIN IMMEDIATE')).toThrow();
          return beforeMidnight;
        },
        'message_read',
      );
      expect(samples).toBe(3);
    } finally {
      other.close();
      f.close();
    }
  });

  it.each(['worker', 'scheduler'] as const)(
    'fails closed if the %s lease expires before the last authorization sample',
    (kind) => {
      const f = fixture();
      try {
        if (kind === 'scheduler') {
          const scheduler = f.access.acquireScheduler('s'.repeat(32), beforeMidnight, 1000)!;
          f.access.startProcessing('user', beforeMidnight);
          Object.assign(
            f.lease,
            f.access.acquireLease('user', 'b'.repeat(32), beforeMidnight, 30_000, scheduler)!,
          );
        }
        let samples = 0;
        expect(() =>
          f.access.authorizeLeasedGmailAttempt(
            f.lease,
            () =>
              samples++ < 2 ? beforeMidnight : beforeMidnight + (kind === 'worker' ? 30_000 : 1000),
            'other',
          ),
        ).toThrow(LeaseLostError);
      } finally {
        f.close();
      }
    },
  );

  it.each([1, 2])(
    'fails closed if approval expires during authorization, sample %s',
    async (at) => {
      const f = fixture();
      try {
        f.access.approve('admin', 'user', beforeMidnight + 300, 100, beforeMidnight);
        let samples = 0;
        const guard = () =>
          f.access.authorizeLeasedGmailAttempt(
            f.lease,
            () => (samples++ < at ? beforeMidnight : beforeMidnight + 300),
            'message_read',
          );
        const mail = new GmailClient(
          gmailApi({ version: 'v1', auth: f.auth }),
          guard,
          (kind, request) => f.auth.execute(kind, guard, request),
        );
        const result = mail.fetchMessage('synthetic', 100);
        await f.refreshing;
        f.release();
        await expect(result).rejects.toBeInstanceOf(AccessDeniedError);
        expect(fakeFetch).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it.each([401, 403])(
    'does not replay HTTP %s with an access token lacking expiry',
    async (status) => {
      const f = fixture();
      try {
        f.auth.setCredentials({ access_token: 'synthetic', refresh_token: 'synthetic-refresh' });
        fakeFetch.mockResolvedValue(
          new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
        );
        await expect(f.makeMail().fetchMessage('synthetic', 100)).rejects.toThrow();
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(1);
      } finally {
        f.close();
      }
    },
  );

  it('does not follow a Gmail redirect', async () => {
    const f = fixture();
    try {
      f.auth.setCredentials({ access_token: 'synthetic', refresh_token: 'synthetic-refresh' });
      fakeFetch.mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'https://example.com/' } }),
      );
      await expect(f.makeMail().fetchMessage('synthetic', 100)).rejects.toThrow();
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(fakeFetch.mock.calls[0]?.[1].redirect).toBe('manual');
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(1);
    } finally {
      f.close();
    }
  });

  it('isolates concurrent attempt contexts sharing one refresh', async () => {
    const f = fixture();
    try {
      fakeFetch.mockImplementation(() =>
        Promise.resolve(
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
      );
      const one = f.makeMail().fetchMessage('one', 100);
      const two = f.makeMail().fetchMessage('two', 100);
      await f.refreshing;
      f.release();
      await Promise.all([one, two]);
      expect(fakeFetch).toHaveBeenCalledTimes(2);
      expect(f.access.readUsage('admin', 'user', beforeMidnight).attempts).toBe(2);
    } finally {
      f.close();
    }
  });

  it('rejects unguarded requests and non-Gmail destinations', async () => {
    const auth = new BetaGmailOAuthClient({ clientId: 'fake', clientSecret: 'fake' });
    await expect(auth.request({ url: 'https://gmail.googleapis.com/synthetic' })).rejects.toThrow(
      'without dispatch guard',
    );
    await expect(
      auth.execute(
        'other',
        () => {},
        () => auth.request({ url: 'https://example.com/' }),
      ),
    ).rejects.toThrow('invalid Gmail transport');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('wires the production Gmail factory to one transport-boundary guard', async () => {
    const prototype = BetaGmailOAuthClient.prototype as unknown as {
      getRequestMetadataAsync: () => Promise<{ headers: Headers }>;
    };
    vi.spyOn(prototype, 'getRequestMetadataAsync').mockResolvedValue({
      headers: new Headers({ authorization: 'Bearer synthetic' }),
    });
    fakeFetch.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const guard = vi.fn();
    const { service, execute } = googleGmailServiceFactory('fake-id', 'fake-secret')(
      'user',
      'fake-refresh',
      guard,
    );
    expect(execute).toBeDefined();
    await new GmailClient(service, guard, execute).fetchMessage('synthetic', 100);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith('message_read');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('reproduces the upstream automatic retry without the beta safeguard', async () => {
    const client = new OAuth2Client({ clientId: 'fake', clientSecret: 'fake' });
    client.setCredentials({ access_token: 'fake-access', refresh_token: 'fake-refresh' });
    const failure = Object.assign(new Error('synthetic failure'), {
      response: { status: 401, config: {} },
    });
    const transport = vi.spyOn(client.transporter, 'request').mockRejectedValue(failure);
    await expect(
      client.request({ url: 'https://gmail.googleapis.com/synthetic', retry: false }),
    ).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
