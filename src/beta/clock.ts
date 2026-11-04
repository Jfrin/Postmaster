import { performance } from 'node:perf_hooks';

const MAX_DRIFT_MS = 5000;

/**
 * Fail closed after a rollback or excessive drift observed in this process.
 * This is not a trusted time source and does not detect changes across restarts.
 */
export function guardBetaClock(
  source: () => number,
  monotonic: () => number = () => performance.now(),
): () => number {
  let last: number | undefined;
  let startWall: number | undefined;
  let startMonotonic: number | undefined;
  let lastMonotonic: number | undefined;
  let failed = false;
  return () => {
    if (failed) throw new Error('beta clock is unavailable');
    try {
      const value = source();
      const elapsed = monotonic();
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 253_402_300_799_999 ||
        (last !== undefined && value < last) ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        (lastMonotonic !== undefined && elapsed < lastMonotonic) ||
        (startWall !== undefined &&
          startMonotonic !== undefined &&
          Math.abs(value - startWall - (elapsed - startMonotonic)) > MAX_DRIFT_MS)
      ) {
        throw new Error('invalid or regressed clock');
      }
      startWall ??= value;
      startMonotonic ??= elapsed;
      last = value;
      lastMonotonic = elapsed;
      return value;
    } catch {
      failed = true;
      throw new Error('beta clock is unavailable');
    }
  };
}
