// Gmail's per-user limit is 6,000 units/minute. Leave headroom for other clients.
// Costs: https://developers.google.com/workspace/gmail/api/reference/quota
const UNITS_PER_MINUTE = 4800;

export class GmailQuotaError extends Error {
  constructor(
    readonly retryAt: number,
    cause: unknown,
  ) {
    super('Gmail quota reached. Processing will retry after the cooldown; progress is saved.', {
      cause,
    });
    this.name = 'GmailQuotaError';
  }
}

function quotaDelay(error: unknown): number | null {
  const e = error as {
    code?: number | string;
    message?: string;
    errors?: { reason?: string }[];
    response?: {
      status?: number;
      headers?: { get?: (name: string) => string | null; 'retry-after'?: string };
      data?: { error?: { message?: string; errors?: { reason?: string }[] } };
    };
  } | null;
  const status = Number(e?.response?.status ?? e?.code);
  const reasons = e?.response?.data?.error?.errors ?? e?.errors ?? [];
  const message = e?.response?.data?.error?.message ?? e?.message ?? '';
  const rateLimited =
    status === 429 ||
    reasons.some((r) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r.reason ?? '')) ||
    /quota exceeded.*(?:per minute|per second)/i.test(message);
  if (!rateLimited) return null;
  const headers = e?.response?.headers;
  const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/** One shared admission queue per Gmail client: overlaps I/O without bursting quota usage. */
export class GmailQuota {
  private queue: Promise<void> = Promise.resolve();
  private nextAt = 0;
  private unitsPerMinute = UNITS_PER_MINUTE;
  private cooldown: GmailQuotaError | null = null;
  private throttles = 0;

  async run<T>(units: number, request: () => Promise<T>): Promise<T> {
    const admitted = this.queue.then(async () => {
      if (this.cooldown && Date.now() < this.cooldown.retryAt) throw this.cooldown;
      const wait = this.nextAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      // A request already in flight may have hit the quota while this one was waiting.
      if (this.cooldown && Date.now() < this.cooldown.retryAt) throw this.cooldown;
      this.nextAt = Date.now() + Math.ceil((units * 60_000) / this.unitsPerMinute);
    });
    this.queue = admitted.catch(() => {});
    await admitted;
    try {
      return await request();
    } catch (error) {
      const retryAfter = quotaDelay(error);
      if (retryAfter === null) throw error;
      if (!this.cooldown || Date.now() >= this.cooldown.retryAt) {
        const delay = Math.max(retryAfter, Math.min(300_000, 60_000 * 2 ** this.throttles++));
        this.unitsPerMinute = Math.max(300, this.unitsPerMinute / 2);
        this.cooldown = new GmailQuotaError(Date.now() + delay, error);
      } else if (Date.now() + retryAfter > this.cooldown.retryAt) {
        this.cooldown = new GmailQuotaError(Date.now() + retryAfter, error);
      }
      throw this.cooldown;
    }
  }
}
