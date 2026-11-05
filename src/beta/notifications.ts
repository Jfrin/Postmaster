import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { BetaAccessStore } from './access.js';

const Credential = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  email: z.string().email(),
});

type Notice = NonNullable<ReturnType<BetaAccessStore['claimNotification']>>;

/** A separately authorized send-only credential, never the user's mailbox-processing token. */
export function gmailNotificationSender(path: string, expectedSender: string, betaUrl: string) {
  let rawCredential: unknown;
  try {
    rawCredential = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('invalid notification credential');
  }
  const parsed = Credential.safeParse(rawCredential);
  if (!parsed.success || parsed.data.email.toLowerCase() !== expectedSender.toLowerCase())
    throw new Error('invalid notification credential');
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(expectedSender))
    throw new Error('invalid notification sender');
  const credential = parsed.data;
  const client = new OAuth2Client(credential.client_id, credential.client_secret);
  client.setCredentials({ refresh_token: credential.refresh_token });
  return async (notice: Notice): Promise<void> => {
    if (
      notice.kind === 'verification' &&
      (!/^\d{8}$/.test(notice.verificationCode ?? '') ||
        notice.expiresAt === null ||
        !Number.isSafeInteger(notice.expiresAt) ||
        notice.expiresAt < 0 ||
        notice.expiresAt > 253_402_300_799_999)
    )
      throw new Error('invalid verification code or expiry');
    const to = notice.kind === 'application' ? expectedSender : notice.email;
    // Never allow untrusted input into MIME headers.
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(to) || to.length > 254)
      throw new Error('invalid recipient');
    const subject =
      notice.kind === 'verification'
        ? 'Verify your Postmaster beta application'
        : notice.kind === 'application'
          ? 'New Postmaster beta application'
          : 'Your Postmaster beta application';
    const body =
      notice.kind === 'verification'
        ? `Your Postmaster beta verification code is ${notice.verificationCode}.\nEnter it at ${betaUrl}/apply before ${new Date(notice.expiresAt!).toISOString()}. A newer requested code replaces it. If you did not request this, ignore this email.\n`
        : notice.kind === 'application'
          ? `A new application was submitted for ${notice.email}.\nReview it at ${betaUrl}/admin\n`
          : notice.kind === 'approved'
            ? `Your Postmaster beta application was approved until ${new Date(notice.expiresAt!).toISOString()}.\nSign in at ${betaUrl} with the same Google account. Gmail consent and Start are separate; processing does not start automatically. Google test-user enrollment may be required.\n`
            : 'Your Postmaster beta application was not approved. Thank you for your interest.\n';
    const raw = Buffer.from(
      `From: ${expectedSender}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64')}\r\n`,
    ).toString('base64url');
    let timer: NodeJS.Timeout | undefined;
    try {
      const access = await Promise.race([
        client.getAccessToken(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('token refresh timed out')), 20_000);
        }),
      ]);
      if (!access.token) throw new Error('notification authorization unavailable');
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error('notification send failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** At-least-once delivery: an ambiguous Gmail/network failure can result in a duplicate. */
export class NotificationWorker {
  private active: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: BetaAccessStore,
    private readonly send: (notice: Notice) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) throw new Error('notification worker already started');
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        console.warn('notification worker unavailable');
      });
    }, 10_000);
    this.timer.unref();
  }

  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      const token = randomBytes(24).toString('base64url');
      const notice = this.store.claimNotification(this.now(), token, false);
      if (!notice) return;
      let delivered = false;
      try {
        await this.send(notice);
        delivered = true;
      } catch {
        console.warn('notification delivery failed');
      }
      this.store.finishNotification(notice.id, token, this.now(), delivered);
    })().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }
}
