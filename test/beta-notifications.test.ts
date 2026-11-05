import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { gmailNotificationSender, NotificationWorker } from '../src/beta/notifications.js';

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    setCredentials() {}
    async getAccessToken() {
      return { token: 'fake-access-token' };
    }
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe('application notifications', () => {
  it('queues only new applications and changed decisions, and supersedes unsent decisions', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      expect(store.submitApplication('Alice@example.com', 1000, true)).toBe(true);
      expect(store.submitApplication('alice@example.com', 1001, true)).toBe(true);
      expect(store.notificationCounts('owner')).toEqual({
        pending: 1,
        failed: 0,
      });
      store.decideApplication('owner', 'alice@example.com', 'approved', 100_000, 100, 1002, true);
      store.decideApplication('owner', 'alice@example.com', 'denied', null, 100, 1003, true);
      const a = store.claimNotification(1004, 'a'.repeat(24))!;
      expect(a.kind).toBe('application');
      store.finishNotification(a.id, 'a'.repeat(24), 1004, true);
      expect(store.claimNotification(1004, 'b'.repeat(24))?.kind).toBe('denied');
      expect(() => store.notificationCounts('not-admin')).toThrow();
    } finally {
      store.close();
    }
  });

  it('updates queued approvals and discards decisions that expired or were superseded', () => {
    const store = new BetaAccessStore(':memory:');
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@example.com', 1000, true);
      const application = store.claimNotification(1000, 'a'.repeat(24))!;
      store.finishNotification(application.id, 'a'.repeat(24), 1000, true);
      store.decideApplication('owner', 'alice@example.com', 'approved', 2000, 100, 1001, true);
      store.decideApplication('owner', 'alice@example.com', 'approved', 3000, 100, 1002, true);
      const approval = store.claimNotification(1002, 'b'.repeat(24))!;
      expect(approval.expiresAt).toBe(3000);
      store.finishNotification(approval.id, 'b'.repeat(24), 1002, false);
      expect(store.claimNotification(3000, 'c'.repeat(24))).toBeNull();
      expect(store.notificationCounts('owner')).toEqual({
        pending: 0,
        failed: 0,
      });
    } finally {
      store.close();
    }
  });

  it('persists failures, bounds retries, permits an admin retry, and recovers expired leases', async () => {
    const store = new BetaAccessStore(':memory:');
    let now = 1000;
    try {
      store.bootstrapAdmin('owner');
      store.submitApplication('alice@example.com', now, true);
      const lease = store.claimNotification(now, 'x'.repeat(24))!;
      expect(store.claimNotification(now, 'y'.repeat(24))).toBeNull();
      now += 120_000;
      const worker = new NotificationWorker(
        store,
        async () => {
          throw new Error('sensitive provider detail');
        },
        () => now,
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (let i = 0; i < 4; i++) {
        await worker.tick();
        now += 4_000_000;
      }
      expect(store.notificationCounts('owner')).toEqual({
        pending: 0,
        failed: 1,
      });
      expect(warn.mock.calls.flat().join(' ')).not.toContain('sensitive provider detail');
      expect(store.failedNotifications('owner')[0]?.id).toBe(lease.id);
      expect(() => store.retryNotification('not-admin', lease.id, now)).toThrow();
      expect(store.retryNotification('owner', lease.id, now)).toBe(true);
      const sent: string[] = [];
      const retry = new NotificationWorker(
        store,
        async (notice) => {
          sent.push(notice.kind);
        },
        () => now,
      );
      await retry.tick();
      expect(sent).toEqual(['application']);
      expect(store.notificationCounts('owner')).toEqual({
        pending: 0,
        failed: 0,
      });
      warn.mockRestore();
    } finally {
      store.close();
    }
  });

  it('uses the separate sender account and sends plain text through Gmail without putting user input in headers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-notice-'));
    try {
      const file = join(dir, 'credential.json');
      writeFileSync(
        file,
        JSON.stringify({
          client_id: 'client',
          client_secret: 'secret',
          refresh_token: 'token',
          email: 'joseofrin@gmail.com',
        }),
      );
      const fetcher = vi.fn(async (_url: string, _options: { body: string }) => ({ ok: true }));
      vi.stubGlobal('fetch', fetcher);
      const send = gmailNotificationSender(
        file,
        'joseofrin@gmail.com',
        'https://example.test/beta',
      );
      await send({
        id: 1,
        email: 'alice@example.com',
        kind: 'approved',
        expiresAt: 100_000,
        attempts: 1,
      });
      const options = fetcher.mock.calls[0]![1] as { body: string };
      const raw = JSON.parse(options.body).raw as string;
      const message = Buffer.from(raw, 'base64url').toString();
      expect(message).toContain('From: joseofrin@gmail.com\r\nTo: alice@example.com');
      expect(message).toContain('Content-Transfer-Encoding: base64');
      await send({
        id: 3,
        email: 'alice@example.com',
        kind: 'application',
        expiresAt: null,
        attempts: 1,
      });
      const alert = Buffer.from(
        JSON.parse(fetcher.mock.calls[1]![1].body).raw as string,
        'base64url',
      ).toString();
      expect(alert).toContain('To: joseofrin@gmail.com');
      expect(Buffer.from(alert.split('\r\n\r\n')[1]!.trim(), 'base64').toString()).toContain(
        'alice@example.com',
      );
      await send({
        id: 4,
        email: 'alice@example.com',
        kind: 'denied',
        expiresAt: null,
        attempts: 1,
      });
      const denial = Buffer.from(
        JSON.parse(fetcher.mock.calls[2]![1].body).raw as string,
        'base64url',
      ).toString();
      expect(denial).toContain('To: alice@example.com');
      await send({
        id: -1,
        email: 'alice@example.com',
        kind: 'verification',
        expiresAt: 100_000,
        attempts: 1,
        verificationCode: '12345678',
      });
      const verification = Buffer.from(
        JSON.parse(fetcher.mock.calls[3]![1].body).raw as string,
        'base64url',
      ).toString();
      expect(verification).toContain('To: alice@example.com');
      expect(Buffer.from(verification.split('\r\n\r\n')[1]!.trim(), 'base64').toString()).toContain(
        '12345678',
      );
      expect(Buffer.from(verification.split('\r\n\r\n')[1]!.trim(), 'base64').toString()).toContain(
        '1970-01-01T00:01:40.000Z',
      );
      await expect(
        send({
          id: -2,
          email: 'alice@example.com',
          kind: 'verification',
          expiresAt: 100_000,
          attempts: 1,
          verificationCode: 'bad',
        }),
      ).rejects.toThrow('invalid verification code or expiry');
      expect(() =>
        gmailNotificationSender(file, 'other@example.com', 'https://example.test/beta'),
      ).toThrow('invalid notification credential');
      await expect(
        send({
          id: 2,
          email: 'alice@example.com\r\nBcc: other@example.com',
          kind: 'denied',
          expiresAt: null,
          attempts: 1,
        }),
      ).rejects.toThrow('invalid recipient');
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
