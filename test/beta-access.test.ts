import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessDeniedError, BetaAccessStore, DailyReadLimitError } from '../src/beta/access.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const tomorrow = Date.parse('2026-11-05T00:00:00Z');
let store: BetaAccessStore;

beforeEach(() => {
  store = new BetaAccessStore(':memory:');
  store.bootstrapAdmin('google-admin-subject');
});
afterEach(() => store.close());

describe('beta access policy foundation', () => {
  it('allows only one bootstrap and requires admin for management', () => {
    expect(() => store.bootstrapAdmin('another-subject')).toThrow(AccessDeniedError);
    store.requestAccess('user-a', 'a@example.com', now);
    expect(() => store.listRequests('user-a')).toThrow(AccessDeniedError);
    expect(() => store.approve('user-a', 'user-a', tomorrow, 100, now)).toThrow(AccessDeniedError);
    expect(() => store.deny('user-a', 'user-a', now)).toThrow(AccessDeniedError);
    expect(() => store.metrics('user-a', now)).toThrow(AccessDeniedError);
    expect(() => store.readUsage('user-a', 'user-a', now)).toThrow(AccessDeniedError);
    expect(() => store.cycleUsage('user-a', 'user-a', now)).toThrow(AccessDeniedError);
    expect(store.listRequests('google-admin-subject')).toEqual([
      {
        subject: 'user-a',
        email: 'a@example.com',
        status: 'pending',
        requestedAt: now,
        expiresAt: null,
        dailyLimit: 100,
      },
    ]);
  });

  it('defaults to denied and stops at the exact approval expiry', () => {
    expect(store.isActive('unknown', now)).toBe(false);
    expect(() => store.reserveRead('unknown', now)).toThrow(AccessDeniedError);
    store.requestAccess('user-a', 'a@example.com', now);
    expect(() => store.reserveRead('user-a', now)).toThrow(AccessDeniedError);
    store.approve('google-admin-subject', 'user-a', now + 1000, 100, now);
    expect(store.isActive('user-a', now + 999)).toBe(true);
    expect(store.reserveRead('user-a', now + 999)).toBe(1);
    expect(store.isActive('user-a', now + 1000)).toBe(false);
    expect(() => store.reserveRead('user-a', now + 1000)).toThrow(AccessDeniedError);
    expect(store.metrics('google-admin-subject', now + 1000).expired).toBe(1);
  });

  it('limits each read attempt per user and resets at midnight UTC', () => {
    for (const [subject, email] of [
      ['user-a', 'a@example.com'],
      ['user-b', 'b@example.com'],
    ]) {
      store.requestAccess(subject!, email!, now);
      store.approve('google-admin-subject', subject!, tomorrow + 1000, 2, now);
    }
    expect(store.reserveRead('user-a', now)).toBe(1);
    expect(store.reserveRead('user-a', now)).toBe(2);
    expect(() => store.reserveRead('user-a', now)).toThrow(DailyReadLimitError);
    expect(store.reserveRead('user-b', now)).toBe(1);
    expect(store.readUsage('google-admin-subject', 'user-a', now)).toEqual({
      day: '2026-11-04',
      attempts: 2,
      limit: 2,
    });
    expect(store.metrics('google-admin-subject', now)).toEqual({
      pending: 0,
      active: 2,
      expired: 0,
      denied: 0,
      readsToday: 3,
      cyclesToday: 0,
      processedToday: 0,
      failedToday: 0,
    });
    expect(store.reserveRead('user-a', tomorrow)).toBe(1);
  });

  it('allows re-request and reapproval but never renews automatically', () => {
    store.requestAccess('user-a', 'a@example.com', now);
    store.approve('google-admin-subject', 'user-a', now + 1000, 4, now);
    store.requestAccess('user-a', 'new@example.com', now + 1);
    expect(store.isActive('user-a', now + 1)).toBe(true);
    store.requestAccess('user-a', 'new@example.com', now + 1000);
    expect(store.isActive('user-a', now + 1001)).toBe(false);
    expect(store.listRequests('google-admin-subject')[0]).toMatchObject({
      status: 'pending',
      dailyLimit: 4,
    });
    store.approve('google-admin-subject', 'user-a', tomorrow, 3, now + 1001);
    expect(store.reserveRead('user-a', now + 1002)).toBe(1);
    store.deny('google-admin-subject', 'user-a', now + 1003);
    expect(() => store.reserveRead('user-a', now + 1004)).toThrow(AccessDeniedError);
    expect(store.metrics('google-admin-subject', now + 1004)).toEqual({
      pending: 0,
      active: 0,
      expired: 0,
      denied: 1,
      readsToday: 1,
      cyclesToday: 0,
      processedToday: 0,
      failedToday: 0,
    });
  });

  it('validates limits, time, and verified identity inputs', () => {
    expect(() => store.requestAccess('', 'a@example.com', now)).toThrow();
    expect(() => store.requestAccess('user-a', 'bad\nemail', now)).toThrow();
    expect(() => store.requestAccess('user-a', 'a@example.com', -1)).toThrow();
    store.requestAccess('user-a', 'a@example.com', now);
    expect(() => store.approve('google-admin-subject', 'missing', tomorrow, 1, now)).toThrow(
      'request not found',
    );
    expect(() => store.approve('google-admin-subject', 'user-a', now, 1, now)).toThrow();
    for (const limit of [-1, 1.5, 100_001]) {
      expect(() => store.approve('google-admin-subject', 'user-a', tomorrow, limit, now)).toThrow();
    }
    store.approve('google-admin-subject', 'user-a', tomorrow, 0, now);
    expect(() => store.reserveRead('user-a', now)).toThrow(DailyReadLimitError);
  });

  it('shares durable counters between independent connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-beta-'));
    const path = join(dir, 'access.db');
    const first = new BetaAccessStore(path);
    const second = new BetaAccessStore(path);
    try {
      first.bootstrapAdmin('admin');
      first.requestAccess('user', 'test@example.com', now);
      first.approve('admin', 'user', tomorrow, 1, now);
      expect(first.reserveRead('user', now)).toBe(1);
      expect(() => second.reserveRead('user', now)).toThrow(DailyReadLimitError);
      second.deny('admin', 'user', now);
      expect(() => first.reserveRead('user', now)).toThrow(AccessDeniedError);
    } finally {
      second.close();
      first.close();
      rmSync(dir, { recursive: true });
    }
  });
});
