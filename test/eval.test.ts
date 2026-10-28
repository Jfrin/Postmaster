import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/eval.js';

describe('evaluate', () => {
  it('computes accuracy and a confusion matrix', () => {
    const r = evaluate([
      { expected: 'dev', predicted: 'dev' },
      { expected: 'dev', predicted: 'work' },
      { expected: 'work', predicted: 'work' },
      { expected: 'work', predicted: 'work' },
    ]);
    expect(r.accuracy).toBe(0.75);
    expect(r.confusion.dev).toEqual({ dev: 1, work: 1 });
  });

  it('handles an empty set', () => {
    expect(evaluate([]).accuracy).toBe(0);
  });
});
