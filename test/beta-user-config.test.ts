import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { AccessDeniedError, BetaAccessStore } from '../src/beta/access.js';
import { BetaUserConfigStore } from '../src/beta/user-config.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const defaults = readFileSync('config/categories.default.yaml', 'utf8');

describe('per-user configuration foundation', () => {
  it('keeps categories, rules and settings isolated and requires active approval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-config-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const config = new BetaUserConfigStore(path, defaults);
    try {
      access.bootstrapAdmin('admin');
      for (const subject of ['alice', 'bob']) {
        access.requestAccess(subject, `${subject}@example.com`, now);
        access.approve('admin', subject, now + 1000, 100, now);
      }
      const alice = config.get('alice', now);
      const bob = config.get('bob', now);
      expect(alice.settings.dry_run).toBe(true);
      expect(alice.settings.backlog_days).toBe(365);
      alice.settings.backlog_days = 30;
      alice.settings.label_prefix = 'ALICE/';
      alice.rules = [
        { match: { from_domain: 'synthetic.example' }, category: alice.settings.fallback_category },
      ];
      config.save('alice', alice, now);
      expect(config.get('alice', now).settings.label_prefix).toBe('ALICE/');
      expect(config.get('alice', now).settings.backlog_days).toBe(30);
      expect(config.get('alice', now).rules).toHaveLength(1);
      expect(config.get('bob', now)).toEqual(bob);
      expect(() => config.get('alice', now + 1000)).toThrow(AccessDeniedError);
      expect(() => config.save('alice', alice, now + 1000)).toThrow(AccessDeniedError);
      expect(() => config.get('unknown', now)).toThrow(AccessDeniedError);
    } finally {
      config.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects unsafe defaults and invalid configuration without changing saved data', () => {
    const unsafe = parseConfig(defaults);
    unsafe.settings.dry_run = false;
    expect(() => new BetaUserConfigStore(':memory:', stringify(unsafe))).toThrow('dry run');
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-config-'));
    const path = join(dir, 'beta.db');
    const access = new BetaAccessStore(path);
    const config = new BetaUserConfigStore(path, defaults);
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 1000, 100, now);
      const original = config.get('alice', now);
      const invalid = structuredClone(original) as unknown as {
        categories: { actions: string[] }[];
      };
      invalid.categories[0]!.actions = ['delete'];
      expect(() => config.save('alice', invalid, now)).toThrow();
      expect(config.get('alice', now)).toEqual(original);
      access.deny('admin', 'alice', now);
      expect(() => config.get('alice', now)).toThrow(AccessDeniedError);
    } finally {
      config.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });
});
