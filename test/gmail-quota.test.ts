import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailQuota, GmailQuotaError } from '../src/gmail-quota.js';

describe('Gmail quota admission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('paces concurrent requests by unit cost while allowing their network I/O to overlap', async () => {
    const quota = new GmailQuota();
    const times: number[] = [];
    let release!: () => void;
    const network = new Promise<void>((resolve) => (release = resolve));
    const first = quota.run(60, () => {
      times.push(Date.now());
      return network;
    });
    const rest = [5, 60].map((cost) => quota.run(cost, async () => void times.push(Date.now())));
    await vi.runAllTimersAsync();
    await Promise.all(rest);
    expect(times).toEqual([0, 750, 813]);
    release();
    await first;
  });

  it.each([
    { code: 429 },
    { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] },
    {
      code: 403,
      message:
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
    },
  ])('shares a cooldown across queued requests and slows down afterward: %j', async (error) => {
    const quota = new GmailQuota();
    const rejected = vi.fn().mockRejectedValue(error);
    const queued = vi.fn().mockResolvedValue('ok');
    const batch = Promise.allSettled([quota.run(60, rejected), quota.run(60, queued)]);
    await vi.runAllTimersAsync();
    const results = await batch;
    expect(
      results.every((r) => r.status === 'rejected' && r.reason instanceof GmailQuotaError),
    ).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(queued).not.toHaveBeenCalled();
    await expect(quota.run(60, queued)).rejects.toMatchObject({ retryAt: 60_000 });
    vi.setSystemTime(60_000);
    await expect(quota.run(60, queued)).resolves.toBe('ok');
    const next = quota.run(60, queued);
    await vi.advanceTimersByTimeAsync(1499);
    expect(queued).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(queued).toHaveBeenCalledTimes(2);
  });

  it.each(['90', 'Thu, 01 Jan 1970 00:01:30 GMT'])('honors Retry-After: %s', async (retryAfter) => {
    const quota = new GmailQuota();
    const error = {
      response: { status: 429, headers: new Headers({ 'retry-after': retryAfter }) },
    };
    await expect(
      quota.run(60, async () => {
        throw error;
      }),
    ).rejects.toMatchObject({ retryAt: 90_000 });
  });

  it('increases the cooldown on repeated throttling', async () => {
    const quota = new GmailQuota();
    const request = vi.fn().mockRejectedValue({ code: 429 });
    await expect(quota.run(60, request)).rejects.toMatchObject({ retryAt: 60_000 });
    vi.setSystemTime(60_000);
    await expect(quota.run(60, request)).rejects.toMatchObject({ retryAt: 180_000 });
  });

  it('does not mistake authentication or daily-limit errors for a minute quota', async () => {
    for (const error of [
      { code: 401 },
      { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] },
    ]) {
      const quota = new GmailQuota();
      await expect(
        quota.run(60, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    }
  });
});
