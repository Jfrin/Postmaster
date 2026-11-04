import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessDeniedError, BetaAccessStore } from '../src/beta/access.js';
import { BetaProcessingEvents, safeHttpStatus } from '../src/beta/processing-events.js';

describe('beta processing events', () => {
  it('keeps bounded, sanitized events isolated to actively approved users', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-events-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const events = new BetaProcessingEvents(path);
    const now = Date.parse('2026-11-04T10:00:00Z');
    try {
      access.bootstrapAdmin('admin');
      for (const subject of ['alice', 'bob']) {
        access.requestAccess(subject, `${subject}@example.com`, now);
        access.approve('admin', subject, now + 60_000, 100, now);
      }
      for (let i = 0; i < 210; i++) events.append('alice', now + i, 'cycle_started');
      events.append('alice', now + 211, 'cycle_failed', { status: 403 });
      events.append('bob', now, 'cycle_completed', { seen: 2, processed: 1, failed: 1 });
      const alice = events.recent('alice', now);
      const bob = events.recent('bob', now);
      expect(alice).toHaveLength(100);
      expect(alice[0]).toMatchObject({ event: 'cycle_failed', status: 403 });
      expect(bob).toHaveLength(1);
      expect(bob[0]).toMatchObject({ event: 'cycle_completed', seen: 2 });
      expect(() => events.recent('alice', now + 60_000)).toThrow(AccessDeniedError);
      expect(() => events.recent('unknown', now)).toThrow(AccessDeniedError);
      expect(() => events.append('alice', now, 'secret' as never)).toThrow('invalid');
      expect(safeHttpStatus({ response: { status: 403, data: 'sensitive' } })).toBe(403);
      expect(safeHttpStatus({ message: 'sensitive', code: 'sensitive' })).toBeUndefined();
    } finally {
      events.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
