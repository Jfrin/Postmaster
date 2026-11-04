import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { stringify } from 'yaml';
import { ConfigSchema, parseConfig, type Config } from '../config.js';
import { AccessDeniedError } from './access.js';

export class ConfigLiveConfirmationError extends Error {}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Configurations are isolated by verified Google subject; no global live YAML is shared. */
export class BetaUserConfigStore {
  private readonly db: DatabaseSyncType;
  private readonly defaultYaml: string;

  constructor(path: string, defaultYaml: string) {
    if (Buffer.byteLength(defaultYaml) > 100_000)
      throw new Error('default configuration too large');
    const defaults = parseConfig(defaultYaml);
    if (!defaults.settings.dry_run) throw new Error('new users must start in dry run');
    this.defaultYaml = stringify(defaults, { lineWidth: 0 });
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS beta_user_configs (
      subject TEXT PRIMARY KEY, yaml TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }

  close(): void {
    this.db.close();
  }

  private withActive<T>(subject: string, now: number, operation: () => T): T {
    if (
      !subject ||
      subject.length > 255 ||
      subject.trim() !== subject ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > 253_402_300_799_999
    )
      throw new Error('invalid user context');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db
        .prepare(
          `SELECT 1 FROM beta_access_requests
        WHERE subject = ? AND status = 'approved' AND expires_at > ?`,
        )
        .get(subject, now);
      if (!active) throw new AccessDeniedError('access not active');
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Subject must be taken from an authenticated session or a fenced worker context. */
  get(subject: string, now: number): Config {
    return this.withActive(subject, now, () => {
      this.db
        .prepare(
          `INSERT INTO beta_user_configs (subject, yaml, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(subject) DO NOTHING`,
        )
        .run(subject, this.defaultYaml, now);
      const row = this.db
        .prepare('SELECT yaml FROM beta_user_configs WHERE subject = ?')
        .get(subject) as { yaml: string };
      return parseConfig(row.yaml);
    });
  }

  save(subject: string, input: unknown, now: number, confirmLive = false): Config {
    const config = ConfigSchema.parse(input);
    const yaml = stringify(config, { lineWidth: 0 });
    if (Buffer.byteLength(yaml) > 100_000) throw new Error('configuration too large');
    return this.withActive(subject, now, () => {
      const previous = this.db
        .prepare('SELECT yaml FROM beta_user_configs WHERE subject = ?')
        .get(subject) as { yaml: string } | undefined;
      const wasDryRun = parseConfig(previous?.yaml ?? this.defaultYaml).settings.dry_run;
      if (wasDryRun && !config.settings.dry_run && !confirmLive)
        throw new ConfigLiveConfirmationError('live-mode confirmation required');
      this.db
        .prepare(
          `INSERT INTO beta_user_configs (subject, yaml, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(subject) DO UPDATE SET yaml = excluded.yaml, updated_at = excluded.updated_at`,
        )
        .run(subject, yaml, now);
      return parseConfig(yaml);
    });
  }
}
