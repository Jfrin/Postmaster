import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, loadConfigFile, parseConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { YAML } from './helpers.js';

describe('config schema', () => {
  it('loads the shipped config/categories.yaml (catches typos before they ship)', () => {
    const cfg = loadConfigFile('config/categories.yaml');
    expect(cfg.categories.length).toBeGreaterThan(5);
    expect(cfg.settings.dry_run).toBe(true); // safe by default
  });

  it('applies defaults', () => {
    const cfg = parseConfig(YAML);
    expect(cfg.settings.confidence_threshold).toBe(0.7);
    expect(cfg.categories[0]?.examples).toEqual([]);
  });

  it('rejects a rule that points at an unknown category', () => {
    const bad = YAML.replace('category: dev', 'category: nope');
    expect(() => parseConfig(bad)).toThrow(/unknown category/);
  });

  it('rejects duplicate ids and a missing fallback', () => {
    expect(() => parseConfig(YAML.replace('id: dev', 'id: receipts'))).toThrow(/duplicate/);
    expect(() => parseConfig(YAML.replace('id: needs_review', 'id: other'))).toThrow(/fallback/);
  });

  it('rejects delete and any other unknown action', () => {
    expect(() => parseConfig(YAML.replace('[label, archive]', '[label, delete]'))).toThrow();
  });

  it('rejects an empty rule match and unknown keys', () => {
    expect(() => parseConfig(YAML.replace('{ from_domain: "github.com" }', '{}'))).toThrow();
    expect(() => parseConfig(`${YAML}\nsurprise: true`)).toThrow();
  });
});

describe('ConfigStore', () => {
  it('keeps the last good config when the file becomes invalid, then recovers', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pm-')), 'categories.yaml');
    writeFileSync(path, YAML);
    const store = new ConfigStore(path, silentLogger);
    expect(store.get().settings.daily_llm_call_cap).toBe(5);

    writeFileSync(path, 'settings: [this is not valid');
    expect(store.reload().settings.daily_llm_call_cap).toBe(5);

    writeFileSync(path, YAML.replace('daily_llm_call_cap: 5', 'daily_llm_call_cap: 9'));
    expect(store.reload().settings.daily_llm_call_cap).toBe(9);
  });

  it('throws if the very first load is invalid', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pm-')), 'bad.yaml');
    writeFileSync(path, 'categories: []');
    expect(() => new ConfigStore(path, silentLogger)).toThrow();
  });
});
