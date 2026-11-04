import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BetaSessionStore } from '../src/beta/session-store.js';

const now = Date.parse('2026-11-04T10:00:00Z');

describe('server-side session storage foundation', () => {
  it('uses an opaque secure cookie, stores only its hash, and expires exactly on time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-session-'));
    const path = join(dir, 'sessions.db');
    const store = new BetaSessionStore(path);
    try {
      const cookie = store.issue('google-subject', 'test@example.com', now, 60_000);
      expect(cookie).toContain('Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax');
      expect(cookie).not.toContain('Domain=');
      const pair = cookie.split(';')[0]!;
      const bearer = pair.split('=')[1]!;
      expect(readFileSync(path).includes(Buffer.from(bearer))).toBe(false);
      const session = store.authenticate(pair, now);
      expect(session).toMatchObject({
        subject: 'google-subject',
        verifiedEmail: 'test@example.com',
      });
      expect(session!.csrfToken.length).toBeGreaterThanOrEqual(32);
      expect(store.authenticate(pair, now + 59_999)).not.toBeNull();
      expect(store.authenticate(pair, now + 60_000)).toBeNull();
      store.revoke(pair);
      expect(store.authenticate(pair, now)).toBeNull();
      expect(BetaSessionStore.clearCookie()).toContain('Max-Age=0; Secure; HttpOnly; SameSite=Lax');
    } finally {
      store.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects malformed, duplicate, expired and unknown session cookies', () => {
    const store = new BetaSessionStore(':memory:');
    try {
      const pair = store.issue('user', 'test@example.com', now, 1000).split(';')[0]!;
      expect(store.authenticate(undefined, now)).toBeNull();
      expect(store.authenticate('__Host-postmaster_session=invalid', now)).toBeNull();
      expect(store.authenticate(`${pair}; ${pair}`, now)).toBeNull();
      expect(store.authenticate(`${pair}; other=ok`, now)).not.toBeNull();
      expect(store.authenticate(pair, -1)).toBeNull();
      expect(store.authenticate(pair, now + 1000)).toBeNull();
      store.revoke('bad');
    } finally {
      store.close();
    }
  });

  it('validates identity and bounded session lifetime', () => {
    const store = new BetaSessionStore(':memory:');
    try {
      expect(() => store.issue('', 'test@example.com', now, 1000)).toThrow();
      expect(() => store.issue('user', 'bad\nemail', now, 1000)).toThrow();
      expect(() => store.issue('user', 'test@example.com', now, 999)).toThrow();
      expect(() => store.issue('user', 'test@example.com', now, 86_400_001)).toThrow();
      expect(() => store.issue('user', 'test@example.com', -1, 1000)).toThrow();
    } finally {
      store.close();
    }
  });
});
