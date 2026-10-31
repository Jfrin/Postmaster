import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentFilteredError, MockClassifier } from '../src/classifier.js';
import { loadConfigFile } from '../src/config.js';
import { readControl, touchHeartbeat } from '../src/control.js';
import { State } from '../src/state.js';
import { createUiServer } from '../src/ui/server.js';
import { YAML } from './helpers.js';

let server: Server;
let base: string;
let configPath: string;
let state: State;
let dataDir: string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-ui-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  configPath = join(dir, 'categories.yaml');
  writeFileSync(configPath, YAML);
  state = new State(':memory:');
  server = createUiServer({
    configPath,
    dataDir,
    state,
    classifier: new MockClassifier(),
    mode: 'mock',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const json = { 'Content-Type': 'application/json' };

describe('UI server', () => {
  it('serves the page', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Postmaster</title>');
  });

  it('serves a page whose inline script parses', async () => {
    const html = await (await fetch(base)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!)).not.toThrow();
  });

  it('returns the config', async () => {
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as { categories: unknown[] };
    expect(cfg.categories).toHaveLength(3);
  });

  it('saves a valid config, keeps a backup, and stays loadable', async () => {
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as {
      settings: { dry_run: boolean };
    };
    cfg.settings.dry_run = true;
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(cfg),
    });
    expect(res.status).toBe(200);
    expect(loadConfigFile(configPath).settings.dry_run).toBe(true);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(YAML);
  });

  it('rejects an invalid config with readable errors and leaves the file alone', async () => {
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as {
      rules: { category: string }[];
    };
    cfg.rules[0]!.category = 'nope';
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(cfg),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('unknown category');
    expect(readFileSync(configPath, 'utf8')).toBe(YAML);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('refuses to save a config that contains a delete action', async () => {
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as {
      categories: { actions: string[] }[];
    };
    cfg.categories[0]!.actions = ['delete'];
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(cfg),
    });
    expect(res.status).toBe(400);
  });

  it('lists recent decisions with sender and subject', async () => {
    state.recordDecision(
      'm1',
      { category: 'receipts', confidence: 0.9, source: 'model', reason: 'r' },
      false,
      new Date(),
      { sender: 'a@b.com', subject: 'Hello' },
    );
    const d = (await (await fetch(`${base}/api/decisions`)).json()) as {
      decisions: { sender: string; subject: string }[];
      dailyCap: number;
    };
    expect(d.decisions[0]).toMatchObject({ sender: 'a@b.com', subject: 'Hello' });
    expect(d.dailyCap).toBe(5);
  });

  it('streams decisions over server-sent events', async () => {
    state.recordDecision(
      'm1',
      { category: 'receipts', confidence: 0.9, source: 'model', reason: 'r' },
      true,
      new Date(),
      { sender: 'stream@b.com', subject: 'Live' },
    );
    const res = await fetch(`${base}/api/activity/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    await reader.cancel();
    expect(text).toContain('data: ');
    expect(text).toContain('stream@b.com');
  });

  it('"Try it" uses rules first, then the classifier, and changes no state', async () => {
    const post = (body: object) =>
      fetch(`${base}/api/try`, { method: 'POST', headers: json, body: JSON.stringify(body) }).then(
        (r) => r.json(),
      );
    const viaRule = (await post({ from: 'x@github.com', subject: 's', body: 'b' })) as {
      source: string;
      category: string;
    };
    expect(viaRule).toMatchObject({ source: 'rule', category: 'dev' });
    const viaModel = (await post({
      from: 'a@shop.com',
      subject: 'Your order shipped',
      body: 'order',
    })) as {
      source: string;
      actions: string[];
    };
    expect(viaModel.source).toBe('model');
    expect(viaModel.actions).toContain('archive');
    const unsure = (await post({ from: 'a@b.com', subject: 'hi', body: 'hello' })) as {
      category: string;
    };
    expect(unsure.category).toBe('needs_review');
    expect(state.recent(10)).toHaveLength(0);
    expect(state.llmCallsToday(new Date())).toBe(0);
  });

  it('rejects bad "Try it" input', async () => {
    const res = await fetch(`${base}/api/try`, {
      method: 'POST',
      headers: json,
      body: '{"from":1}',
    });
    expect(res.status).toBe(400);
  });

  it('shows a content-filtered outcome in "Try it" without changing state', async () => {
    const classify = vi
      .spyOn(MockClassifier.prototype, 'classify')
      .mockRejectedValueOnce(new ContentFilteredError('filtered'));
    try {
      const res = await fetch(`${base}/api/try`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ from: 'x@example.com', subject: 's', body: 'b' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        category: 'content_filtered',
        label: 'AI/Content Filtered',
        actions: ['label'],
        reason: 'Azure content filtered',
      });
      expect(state.recent(10)).toHaveLength(0);
    } finally {
      classify.mockRestore();
    }
  });

  it('blocks non-localhost Host headers (DNS rebinding)', async () => {
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/config', headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.end();
    });
    expect(status).toBe(403);
  });

  it('blocks cross-site writes and non-JSON writes', async () => {
    const cross = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { ...json, Origin: 'http://evil.example' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
    const form = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(form.status).toBe(415);
  });

  it('reports the poller as offline until it sends a heartbeat, and refuses Start', async () => {
    const status = (await (await fetch(`${base}/api/status`)).json()) as {
      online: boolean;
      running: boolean;
    };
    expect(status).toMatchObject({ online: false, running: false });
    const res = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: json,
      body: '{"action":"start"}',
    });
    expect(res.status).toBe(409);
    expect(readControl(dataDir).running).toBe(false);
  });

  it('Start and Stop flip the control flag when the poller is online', async () => {
    touchHeartbeat(dataDir);
    const post = (action: string) =>
      fetch(`${base}/api/control`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ action }),
      });
    const started = (await (await post('start')).json()) as { running: boolean; online: boolean };
    expect(started).toMatchObject({ running: true, online: true });
    expect(readControl(dataDir).running).toBe(true);
    const stopped = (await (await post('stop')).json()) as { running: boolean };
    expect(stopped.running).toBe(false);
  });

  it('refuses to Start with an invalid config, and rejects unknown actions', async () => {
    touchHeartbeat(dataDir);
    writeFileSync(configPath, 'categories: []');
    const bad = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: json,
      body: '{"action":"start"}',
    });
    expect(bad.status).toBe(400);
    expect(readControl(dataDir).running).toBe(false);
    const odd = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: json,
      body: '{"action":"nuke"}',
    });
    expect(odd.status).toBe(400);
  });

  it('404s unknown paths', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
