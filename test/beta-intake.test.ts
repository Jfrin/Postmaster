import { describe, expect, it } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';

const now = Date.parse('2026-11-04T10:00:00Z');

describe('closed beta intake', () => {
  it('does not reset decisions on duplicate submissions and expires admitted accounts', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      expect(store.submitApplication('alice@gmail.com', now)).toBe(true);
      expect(store.claimApplication('alice', 'alice@gmail.com', now)).toBe(false);
      store.decideApplication('owner', 'alice@gmail.com', 'approved', now + 1000, 42, now);
      expect(store.submitApplication('ALICE@gmail.com', now + 1)).toBe(true);
      expect(store.listApplications('owner')).toMatchObject([
        { status: 'approved', dailyLimit: 42 },
      ]);
      expect(store.claimApplication('alice', 'alice@gmail.com', now + 2)).toBe(true);
      expect(store.isActive('alice', now + 2)).toBe(true);
      expect(store.isApplicationAdmitted('alice', 'alice@gmail.com', now + 1000)).toBe(false);
      expect(store.claimApplication('alice', 'alice@gmail.com', now + 1000)).toBe(false);
      store.decideApplication('owner', 'alice@gmail.com', 'approved', now + 2000, 100, now + 1001);
      expect(store.isApplicationAdmitted('alice', 'alice@gmail.com', now + 1002)).toBe(true);
      expect(store.processingRequested('alice')).toBe(false);
      store.decideApplication('owner', 'alice@gmail.com', 'denied', null, 100, now + 1003);
      expect(store.submitApplication('alice@gmail.com', now + 1004)).toBe(true);
      expect(store.listApplications('owner')[0]!.status).toBe('denied');
      expect(store.claimApplication('alice', 'alice@gmail.com', now + 1004)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('caps submission attempts across restarts of the request handler', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      for (let n = 0; n < 100; n++)
        expect(store.submitApplication('same@gmail.com', now)).toBe(true);
      expect(store.submitApplication('other@gmail.com', now)).toBe(false);
      expect(store.submitApplication('other@gmail.com', now + 3_600_000)).toBe(true);
    } finally {
      store.close();
    }
  });
});
