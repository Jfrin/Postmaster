import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { State } from '../src/state.js';
import { BetaAccessStore } from '../src/beta/access.js';
import { BetaActivityStore } from '../src/beta/activity.js';
import { BetaDataPrivacy, privateStateIdentifiers } from '../src/beta/data-privacy.js';
import { GmailConsentStateStore } from '../src/beta/gmail-consent-state.js';
import { BetaProcessingEvents } from '../src/beta/processing-events.js';
import { BetaSessionStore } from '../src/beta/session-store.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';
import { BetaUserConfigStore } from '../src/beta/user-config.js';
import { createBetaStateWriteGuard } from '../src/beta/state-guard.js';

const now = Date.parse('2026-11-05T09:00:00Z');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
const decision = {
  category: 'receipts',
  confidence: 0.95,
  source: 'model' as const,
  reason: 'private email body',
};

describe('beta privacy data separation', () => {
  it('migrates legacy decisions and sender cache, retains only temporary display metadata, and preserves deduplication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-private-migrate-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const access = new BetaAccessStore(path);
    const legacy = new State(path, 'alice');
    legacy.recordDecision('message-secret', decision, false, new Date(now), {
      sender: 'alice-sender@example.com',
      subject: 'private subject',
    });
    legacy.observeSender('alice-sender@example.com', 'receipts', 1);
    legacy.close();
    const privacy = new BetaDataPrivacy(path, key, now);
    const db = new DatabaseSync(path);
    const state = new State(path, 'alice', undefined, privateStateIdentifiers(key, 'alice'));
    try {
      const row = db.prepare('SELECT * FROM decisions').get() as Record<string, unknown>;
      expect(row.message_id).toMatch(/^h1:[a-f0-9]{64}$/);
      expect(row.sender).toBeNull();
      expect(row.subject).toBeNull();
      expect(row.reason).toBe('');
      expect(JSON.stringify(db.prepare('SELECT * FROM sender_cache').all())).not.toContain(
        'alice-sender@example.com',
      );
      expect(state.hasDecision('message-secret')).toBe(true);
      expect(db.prepare('SELECT subject FROM beta_email_content').get()).toEqual(
        expect.objectContaining({ subject: 'private subject' }),
      );
      expect(privateStateIdentifiers(key, 'alice').message('same')).not.toBe(
        privateStateIdentifiers(key, 'bob').message('same'),
      );
      privacy.cleanup(now + 86_400_000);
      expect(db.prepare('SELECT count(*) AS n FROM beta_email_content').get()!.n).toBe(0);
      expect(state.hasDecision('message-secret')).toBe(true);
      expect(() => new BetaDataPrivacy(path, randomBytes(32), now)).toThrow(
        'private state key changed',
      );
    } finally {
      state.close();
      db.close();
      privacy.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('separates deletion scopes, fences in-flight writes, and does not erase another user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-private-delete-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    const config = new BetaUserConfigStore(
      path,
      readFileSync('config/categories.default.yaml', 'utf8'),
    );
    const activity = new BetaActivityStore(path);
    const sessions = new BetaSessionStore(path);
    const consent = new GmailConsentStateStore(path);
    const events = new BetaProcessingEvents(path);
    const privacy = new BetaDataPrivacy(path, key, now);
    const db = new DatabaseSync(path);
    access.bootstrapAdmin('admin');
    for (const name of ['alice', 'bob']) {
      access.requestAccess(name, `${name}@example.com`, now);
      access.approve('admin', name, now + 3 * 86_400_000, 100, now);
      vault.save(name, 'synthetic-token');
      config.get(name, now);
      access.startProcessing(name, now);
      const state = new State(path, name, undefined, privateStateIdentifiers(key, name));
      state.recordDecision('message', decision, false, new Date(now), {
        sender: `${name}@example.com`,
        subject: 'private subject',
      });
      state.observeSender(`${name}@example.com`, 'receipts', 1);
      state.close();
    }
    const lease = access.acquireLease('alice', 'a'.repeat(32), now, 30_000)!;
    const guarded = new State(
      path,
      'alice',
      createBetaStateWriteGuard(lease, () => now),
      privateStateIdentifiers(key, 'alice'),
    );
    try {
      db.prepare('UPDATE beta_gmail_consent_fences SET revoking=1 WHERE subject=?').run('alice');
      expect(() => privacy.delete('alice', 'alice@example.com', 'account', now)).toThrow(
        'revocation',
      );
      expect(access.processingRequested('alice')).toBe(true);
      db.prepare('UPDATE beta_gmail_consent_fences SET revoking=0 WHERE subject=?').run('alice');
      privacy.delete('alice', 'alice@example.com', 'content', now);
      expect(access.processingRequested('alice')).toBe(false);
      expect(() =>
        guarded.recordDecision('late', decision, false, new Date(now), { subject: 'late' }),
      ).toThrow();
      expect(() =>
        events.append(
          'alice',
          now,
          'cycle_completed',
          {},
          createBetaStateWriteGuard(lease, () => now),
        ),
      ).toThrow();
      expect(activity.recent('alice', now)[0]!.subject).toBeNull();
      expect(activity.recent('bob', now)[0]!.subject).toBe('private subject');
      expect(activity.recent('bob', now + 86_400_000)[0]!.subject).toBeNull();
      expect(
        db.prepare('SELECT count(*) AS n FROM sender_cache WHERE user_id=?').get('alice')!.n,
      ).toBe(1);
      privacy.delete('alice', 'alice@example.com', 'decisions', now);
      expect(
        db.prepare('SELECT count(*) AS n FROM decisions WHERE user_id=?').get('alice')!.n,
      ).toBe(0);
      expect(
        db.prepare('SELECT count(*) AS n FROM sender_cache WHERE user_id=?').get('alice')!.n,
      ).toBe(0);
      const restored = new State(path, 'alice', undefined, privateStateIdentifiers(key, 'alice'));
      restored.recordDecision('remaining', decision, false, new Date(now), {
        subject: 'remaining',
      });
      restored.close();
      privacy.delete('alice', 'alice@example.com', 'other', now);
      expect(access.ownRequest('alice')).not.toBeNull();
      expect(vault.has('alice')).toBe(true);
      expect(
        db.prepare('SELECT count(*) AS n FROM decisions WHERE user_id=?').get('alice')!.n,
      ).toBe(1);
      expect(
        db.prepare('SELECT count(*) AS n FROM beta_email_content WHERE user_id=?').get('alice')!.n,
      ).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM decisions WHERE user_id=?').get('bob')!.n).toBe(
        1,
      );
      access.reserveRead('bob', now);
      const cookie = sessions.issue('bob', 'bob@example.com', now, 60_000);
      privacy.delete('bob', 'bob@example.com', 'all', now);
      expect(sessions.authenticate(cookie, now)).not.toBeNull();
      expect(vault.has('bob')).toBe(true);
      expect(access.ownRequest('bob')).not.toBeNull();
      expect(
        db.prepare('SELECT count(*) AS n FROM beta_email_content WHERE user_id=?').get('bob')!.n,
      ).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM decisions WHERE user_id=?').get('bob')!.n).toBe(
        0,
      );
      expect(() => privacy.delete('bob', 'bob@example.com', 'account', now)).toThrow('revoked');
      const token = vault.beginDisconnect('bob')!;
      expect(vault.finishDisconnect('bob', token)).toBe(true);
      privacy.delete('bob', 'bob@example.com', 'account', now);
      expect(sessions.authenticate(cookie, now)).toBeNull();
      expect(vault.has('bob')).toBe(false);
      expect(access.ownRequest('bob')).toBeNull();
      expect(
        db.prepare('SELECT attempts FROM beta_read_attempts WHERE subject=?').get('bob')!.attempts,
      ).toBe(1);
      privacy.cleanup(now + 86_400_000);
      expect(
        db.prepare('SELECT count(*) AS n FROM beta_read_attempts WHERE subject=?').get('bob')!.n,
      ).toBe(0);
    } finally {
      guarded.close();
      db.close();
      privacy.close();
      events.close();
      consent.close();
      sessions.close();
      activity.close();
      config.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
