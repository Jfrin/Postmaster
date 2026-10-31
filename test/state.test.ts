import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { State } from '../src/state.js';

const NOW = new Date('2026-10-28T10:00:00Z');
const D = { category: 'receipts', confidence: 0.9, source: 'model' as const, reason: 'r' };

describe('State', () => {
  it('stores and reads the history cursor', () => {
    const s = new State(':memory:');
    expect(s.getCursor()).toBeNull();
    s.setCursor('42');
    expect(s.getCursor()).toBe('42');
  });

  it('records decisions idempotently', () => {
    const s = new State(':memory:');
    s.recordDecision('m1', D, true, NOW);
    s.recordDecision('m1', { ...D, category: 'dev' }, true, NOW);
    expect(s.hasDecision('m1')).toBe(true);
    expect(s.appliedSince('2026-10-28T00:00:00Z')).toHaveLength(1);
    expect(s.appliedSince('2026-10-28T00:00:00Z')[0]?.category).toBe('receipts');
  });

  it('hasDecision can ignore dry-run decisions', () => {
    const s = new State(':memory:');
    s.recordDecision('m1', D, false, NOW);
    expect(s.hasDecision('m1')).toBe(true);
    expect(s.hasDecision('m1', true)).toBe(false);
  });

  it('excludes dry-run decisions from appliedSince', () => {
    const s = new State(':memory:');
    s.recordDecision('m1', D, false, NOW);
    expect(s.appliedSince('2026-01-01T00:00:00Z')).toHaveLength(0);
  });

  it('caches a sender only after three consistent high-confidence results', () => {
    const s = new State(':memory:');
    s.observeSender('a@x.com', 'receipts', 0.95);
    s.observeSender('a@x.com', 'receipts', 0.95);
    expect(s.cachedCategory('a@x.com')).toBeNull();
    s.observeSender('a@x.com', 'receipts', 0.95);
    expect(s.cachedCategory('a@x.com')).toBe('receipts');
  });

  it('resets the streak on a different category or low confidence', () => {
    const s = new State(':memory:');
    for (let i = 0; i < 2; i++) s.observeSender('a@x.com', 'receipts', 0.95);
    s.observeSender('a@x.com', 'dev', 0.95);
    s.observeSender('a@x.com', 'dev', 0.95);
    expect(s.cachedCategory('a@x.com')).toBeNull();
    s.observeSender('a@x.com', 'dev', 0.5);
    s.observeSender('a@x.com', 'dev', 0.95);
    expect(s.cachedCategory('a@x.com')).toBeNull();
  });

  it('counts model calls per day', () => {
    const s = new State(':memory:');
    s.countLlmCall(NOW);
    s.countLlmCall(NOW);
    expect(s.llmCallsToday(NOW)).toBe(2);
    expect(s.llmCallsToday(new Date('2026-10-29T00:00:00Z'))).toBe(0);
  });

  it('keeps users separate', () => {
    const a = new State(':memory:', 'a');
    a.setCursor('1');
    expect(a.getCursor()).toBe('1');
  });
});

describe('State UI support', () => {
  it('returns recent decisions newest first, with sender and subject', () => {
    const s = new State(':memory:');
    s.recordDecision('a', D, true, new Date('2026-10-28T09:00:00Z'), {
      sender: 'x@y.com',
      subject: 'First',
    });
    s.recordDecision('b', D, true, new Date('2026-10-28T10:00:00Z'));
    const rows = s.recent(10);
    expect(rows.map((r) => r.message_id)).toEqual(['b', 'a']);
    expect(rows[1]).toMatchObject({ sender: 'x@y.com', subject: 'First' });
    expect(s.recent(1)).toHaveLength(1);
  });

  it('migrates a database created before sender and subject existed', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: typeof DatabaseSyncType;
    };
    const path = join(mkdtempSync(join(tmpdir(), 'pm-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE decisions (user_id TEXT, message_id TEXT, category TEXT, confidence REAL,
      source TEXT, reason TEXT, applied INTEGER, created_at TEXT, PRIMARY KEY (user_id, message_id))`);
    old.close();
    const s = new State(path);
    s.recordDecision('m', D, true, NOW, { sender: 's', subject: 'subj' });
    expect(s.recent(1)[0]?.subject).toBe('subj');
  });
});
