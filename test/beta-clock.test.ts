import { describe, expect, it } from 'vitest';
import { guardBetaClock } from '../src/beta/clock.js';

describe('beta clock guard', () => {
  it('latches closed on an observed rollback even if the source recovers', () => {
    let time = 1000;
    const now = guardBetaClock(() => time);
    expect(now()).toBe(1000);
    expect(now()).toBe(1000);
    time = 1001;
    expect(now()).toBe(1001);
    time = 1000;
    expect(now).toThrow('beta clock is unavailable');
    time = 2000;
    expect(now).toThrow('beta clock is unavailable');
  });

  it.each([-1, NaN, Infinity, 1.5, 253_402_300_800_000])(
    'latches closed on invalid time %s',
    (invalid) => {
      let time = invalid;
      const now = guardBetaClock(() => time);
      expect(now).toThrow('beta clock is unavailable');
      time = 1000;
      expect(now).toThrow('beta clock is unavailable');
    },
  );

  it('latches closed if the source throws without exposing its error', () => {
    const now = guardBetaClock(() => {
      throw new Error('sensitive source failure');
    });
    expect(now).toThrow('beta clock is unavailable');
    expect(now).toThrow('beta clock is unavailable');
  });

  it('rejects cumulative forward jumps compared with monotonic elapsed time', () => {
    let wall = 1000;
    let ticks = 0;
    const now = guardBetaClock(
      () => wall,
      () => ticks,
    );
    expect(now()).toBe(1000);
    ticks = 1000;
    wall = 5000;
    expect(now()).toBe(5000);
    ticks = 2000;
    wall = 9001;
    expect(now).toThrow('beta clock is unavailable');
  });

  it('latches closed when wall time stops while monotonic time advances', () => {
    let ticks = 0;
    const now = guardBetaClock(
      () => 1000,
      () => ticks,
    );
    expect(now()).toBe(1000);
    ticks = 5000;
    expect(now()).toBe(1000);
    ticks = 5001;
    expect(now).toThrow('beta clock is unavailable');
    ticks = 0;
    expect(now).toThrow('beta clock is unavailable');
  });

  it('rejects cumulative slow wall-clock drift without an observed rollback', () => {
    let wall = 1000;
    let ticks = 0;
    const now = guardBetaClock(
      () => wall,
      () => ticks,
    );
    expect(now()).toBe(1000);
    ticks = 4000;
    wall = 2000;
    expect(now()).toBe(2000);
    ticks = 8001;
    wall = 4000;
    expect(now).toThrow('beta clock is unavailable');
  });

  it('allows normal forward elapsed time and fails closed if monotonic time regresses', () => {
    let wall = 1000;
    let ticks = 0;
    const now = guardBetaClock(
      () => wall,
      () => ticks,
    );
    expect(now()).toBe(1000);
    ticks = 100_000;
    wall = 101_000;
    expect(now()).toBe(101_000);
    ticks--;
    expect(now).toThrow('beta clock is unavailable');
  });
});
