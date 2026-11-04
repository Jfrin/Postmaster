import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError, BetaAccessStore, DailyReadLimitError } from '../src/beta/access.js';
import { createBetaGmailGuard } from '../src/beta/gmail-guard.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { GmailClient } from '../src/gmail.js';

const now = Date.parse('2026-11-04T10:00:00Z');
let store: BetaAccessStore;
let vault: GmailTokenVault;
let dir: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  dir = mkdtempSync(join(tmpdir(), 'postmaster-gmail-guard-'));
  const path = join(dir, 'beta.db');
  store = new BetaAccessStore(path);
  vault = new GmailTokenVault(path, randomBytes(32));
  store.bootstrapAdmin('admin');
  store.requestAccess('user', 'user@example.com', now);
  vault.save('user', 'synthetic-refresh-token');
});

afterEach(() => {
  vault.close();
  store.close();
  rmSync(dir, { recursive: true });
  vi.useRealTimers();
});

describe('beta Gmail request guard', () => {
  it('blocks cached workers as soon as a connection is disabled or removed', () => {
    store.approve('admin', 'user', now + 60_000, 100, now);
    const guard = createBetaGmailGuard(store, 'user');
    expect(() => guard('other')).not.toThrow();
    expect(vault.disableAndLoad('user')).toBe('synthetic-refresh-token');
    expect(() => guard('other')).toThrow(AccessDeniedError);
    expect(() => guard('message_read')).toThrow(AccessDeniedError);
    expect(vault.loadIfActive('user', now)).toBeNull();
    expect(store.readUsage('admin', 'user', now).attempts).toBe(0);
    vault.save('user', 'replacement-token');
    expect(() => guard('message_read')).not.toThrow();
    vault.delete('user');
    expect(() => guard('other')).toThrow(AccessDeniedError);
  });

  it('counts failed message attempts and blocks another attempt at the limit', async () => {
    store.approve('admin', 'user', now + 60_000, 2, now);
    const get = vi.fn().mockRejectedValue(new Error('temporary failure'));
    const client = new GmailClient(
      { users: { messages: { get } } } as unknown as gmail_v1.Gmail,
      createBetaGmailGuard(store, 'user'),
    );
    const results = Promise.allSettled([
      client.fetchMessage('one', 100),
      client.fetchMessage('one', 100),
      client.fetchMessage('one', 100),
    ]);
    await vi.runAllTimersAsync();
    const settled = await results;
    expect(settled[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'temporary failure' },
    });
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: { message: 'temporary failure' },
    });
    expect(settled[2]).toMatchObject({
      status: 'rejected',
      reason: expect.any(DailyReadLimitError),
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.readUsage('admin', 'user', now).attempts).toBe(2);
  });

  it('rechecks expiry after waiting in the Gmail quota queue', async () => {
    store.approve('admin', 'user', now + 500, 100, now);
    const get = vi.fn().mockResolvedValue({ data: {} });
    const client = new GmailClient(
      { users: { messages: { get } } } as unknown as gmail_v1.Gmail,
      createBetaGmailGuard(store, 'user'),
    );
    const results = Promise.allSettled([
      client.fetchMessage('one', 100),
      client.fetchMessage('two', 100),
    ]);
    await vi.runAllTimersAsync();
    const settled = await results;
    expect(settled[0]?.status).toBe('fulfilled');
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: expect.any(AccessDeniedError) });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('blocks non-read Gmail API calls when access has expired', async () => {
    store.approve('admin', 'user', now + 500, 100, now);
    vi.setSystemTime(now + 500);
    const call = vi.fn().mockResolvedValue({ data: {} });
    const service = {
      users: { getProfile: call, labels: { list: call }, messages: { modify: call } },
    } as unknown as gmail_v1.Gmail;
    const guard = createBetaGmailGuard(store, 'user');
    const results = Promise.allSettled([
      new GmailClient(service, guard).listNew(null, 7),
      new GmailClient(service, guard).ensureLabels(['AI/Test'], false),
      new GmailClient(service, guard).modify('one', { add: ['label'], remove: [] }),
    ]);
    await vi.runAllTimersAsync();
    for (const result of await results) {
      expect(result).toMatchObject({ status: 'rejected', reason: expect.any(AccessDeniedError) });
    }
    expect(call).not.toHaveBeenCalled();
  });
});
