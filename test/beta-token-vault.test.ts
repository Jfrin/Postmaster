import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AccessDeniedError, BetaAccessStore } from '../src/beta/access.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

describe('encrypted Gmail token storage foundation', () => {
  it('migrates an existing token table to support disabling a connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-vault-migration-'));
    const path = join(dir, 'beta.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE beta_gmail_tokens (subject TEXT PRIMARY KEY, version INTEGER NOT NULL,
      nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL)`);
    db.close();
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      vault.save('user', 'synthetic-token');
      expect(vault.disableAndLoad('user')).toBe('synthetic-token');
      expect(vault.load('user')).toBe('synthetic-token');
    } finally {
      vault.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('atomically rejects token storage and retrieval without active approval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-vault-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, randomBytes(32));
    const now = Date.parse('2026-11-04T10:00:00Z');
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('user', 'test@example.com', now);
      expect(() => vault.saveIfActive('user', 'token', now)).toThrow(AccessDeniedError);
      access.approve('admin', 'user', now + 1000, 100, now);
      vault.saveIfActive('user', 'token', now);
      expect(vault.loadIfActive('user', now + 999)).toBe('token');
      expect(() => vault.loadIfActive('user', now + 1000)).toThrow(AccessDeniedError);
      expect(() => vault.saveIfActive('user', 'replacement', now + 1000)).toThrow(
        AccessDeniedError,
      );
      expect(vault.load('user')).toBe('token');
      access.deny('admin', 'user', now + 500);
      expect(() => vault.loadIfActive('user', now + 501)).toThrow(AccessDeniedError);
    } finally {
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('stores independently encrypted tokens without plaintext and can remove one user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-vault-'));
    const path = join(dir, 'tokens.db');
    const vault = new GmailTokenVault(path, randomBytes(32));
    try {
      vault.save('user-a', 'synthetic-refresh-token-a');
      vault.save('user-b', 'synthetic-refresh-token-b');
      expect(vault.load('user-a')).toBe('synthetic-refresh-token-a');
      expect(vault.load('user-b')).toBe('synthetic-refresh-token-b');
      expect(vault.load('other')).toBeNull();
      expect(readFileSync(path).includes(Buffer.from('synthetic-refresh-token-a'))).toBe(false);
      vault.delete('user-a');
      expect(vault.load('user-a')).toBeNull();
      expect(vault.load('user-b')).toBe('synthetic-refresh-token-b');
    } finally {
      vault.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects wrong keys, tampering, and moving an encrypted record to another subject', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-vault-'));
    const path = join(dir, 'tokens.db');
    const vault = new GmailTokenVault(path, randomBytes(32));
    const wrongKey = new GmailTokenVault(path, randomBytes(32));
    const db = new DatabaseSync(path);
    try {
      vault.save('user-a', 'synthetic-refresh-token');
      expect(() => wrongKey.load('user-a')).toThrow('cannot be decrypted');
      db.prepare("UPDATE beta_gmail_tokens SET subject = 'user-b' WHERE subject = 'user-a'").run();
      expect(() => vault.load('user-b')).toThrow('cannot be decrypted');
      vault.save('user-a', 'synthetic-refresh-token');
      db.prepare("UPDATE beta_gmail_tokens SET tag = ? WHERE subject = 'user-a'").run(
        randomBytes(16),
      );
      expect(() => vault.load('user-a')).toThrow('cannot be decrypted');
    } finally {
      db.close();
      wrongKey.close();
      vault.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('validates keys, subjects and tokens', () => {
    expect(() => new GmailTokenVault(':memory:', randomBytes(31))).toThrow('32 bytes');
    const vault = new GmailTokenVault(':memory:', randomBytes(32));
    try {
      expect(() => vault.save('', 'token')).toThrow('subject');
      expect(() => vault.save('user', '')).toThrow('token');
      expect(() => vault.save('user', 'x'.repeat(16_385))).toThrow('token');
      expect(() => vault.delete('')).toThrow('subject');
      vault.save('user', 'first');
      vault.save('user', 'replacement');
      expect(vault.load('user')).toBe('replacement');
    } finally {
      vault.close();
    }
  });
});
