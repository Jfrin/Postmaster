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
