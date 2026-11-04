import { readFileSync } from 'node:fs';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfigFile } from '../src/config.js';
import { createDemoServer } from '../src/demo/server.js';

let server: Server;
let base: string;
const origin = 'https://demo.example.com';

beforeEach(async () => {
  server = createDemoServer(loadConfigFile('config/categories.default.yaml'), origin);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('isolated mock demo', () => {
  it('reserves distinct proxy addresses and trusts only Caddy', () => {
    const compose = parse(readFileSync('docker-compose.demo.yml', 'utf8')) as {
      services: {
        auth: { command: string[]; networks: { edge: { ipv4_address: string } }; ports?: unknown };
        caddy: { networks: { edge: { ipv4_address: string } } };
        demo: { ports?: unknown };
      };
    };
    const { auth, caddy, demo } = compose.services;
    expect(auth.networks.edge.ipv4_address).not.toBe(caddy.networks.edge.ipv4_address);
    expect(auth.command).toContain(`--trusted-proxy-ip=${caddy.networks.edge.ipv4_address}/32`);
    expect(auth.ports).toBeUndefined();
    expect(demo.ports).toBeUndefined();
  });

  it('serves a synthetic-only page with valid script', async () => {
    const html = await (await fetch(base)).text();
    expect(html).toContain('No Gmail connection');
    expect(html).toContain('Activity and settings below are examples');
    expect(html).toContain('Start</button>');
    expect(html).toContain('disabled title="Not available in the demo"');
    expect(html).toContain('/oauth2/sign_out');
    expect(html).toContain('href="/">Home</a>');
    for (const id of ['activity', 'categories', 'rules', 'settings', 'try']) {
      expect(html).toContain(`aria-controls="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!)).not.toThrow();
  });

  it('serves the synthetic demo at its new path', async () => {
    for (const path of ['/demo', '/demo/']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('No Gmail connection');
    }
  });

  it('switches demo sections and sends only synthetic try-it input to the classifier', async () => {
    const html = await (await fetch(base)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const ids = ['activity', 'categories', 'rules', 'settings', 'try'];
    const panels = Object.fromEntries(ids.map((id, index) => [id, { hidden: index !== 0 }]));
    const tabs = ids.map((id) => ({
      attrs: { 'aria-controls': id, 'aria-pressed': id === 'activity' ? 'true' : 'false' },
      click: () => {},
      addEventListener(_event: string, fn: () => void) {
        this.click = fn;
      },
      getAttribute(key: 'aria-controls' | 'aria-pressed') {
        return this.attrs[key];
      },
      setAttribute(key: 'aria-pressed', value: string) {
        this.attrs[key] = value;
      },
    }));
    let submit: (event: { preventDefault: () => void }) => Promise<void> = async () => {};
    const result = { textContent: '' };
    const elements: Record<string, unknown> = {
      ...panels,
      form: { addEventListener: (_event: string, fn: typeof submit) => (submit = fn) },
      result,
      from: { value: 'orders@example.com' },
      subject: { value: 'Your order shipped' },
      body: { value: 'Synthetic order.' },
    };
    const calls: { path: string; options: RequestInit }[] = [];
    vm.runInNewContext(script, {
      document: {
        querySelectorAll: () => tabs,
        getElementById: (id: string) => elements[id],
      },
      fetch: async (path: string, options: RequestInit) => {
        calls.push({ path, options });
        return {
          ok: true,
          json: async () => ({ category: 'receipts', confidence: 0.9, reason: 'Mock' }),
        };
      },
    });
    tabs[4]!.click();
    expect(panels.try!.hidden).toBe(false);
    expect(panels.activity!.hidden).toBe(true);
    expect(tabs[4]!.attrs['aria-pressed']).toBe('true');
    await submit({ preventDefault: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/try');
    expect(JSON.parse(String(calls[0]!.options.body))).toEqual({
      from: 'orders@example.com',
      subject: 'Your order shipped',
      body: 'Synthetic order.',
    });
    expect(result.textContent).toContain('Category: receipts\nConfidence: 90%');
  });

  it('classifies a synthetic message without persistence', async () => {
    const res = await fetch(`${base}/api/try`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'orders@example.com',
        subject: 'Your order shipped',
        body: 'Synthetic order.',
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toHaveProperty('category');
  });

  it('rejects cross-origin and non-JSON requests', async () => {
    const cases: Record<string, string>[] = [
      { Origin: 'https://other.example', 'Content-Type': 'application/json' },
      { Origin: origin, 'Content-Type': 'text/plain' },
      { 'Content-Type': 'application/json' },
    ];
    for (const headers of cases) {
      const res = await fetch(`${base}/api/try`, { method: 'POST', headers, body: '{}' });
      expect(res.status).toBe(403);
    }
  });

  it('does not expose administrative or Gmail routes', async () => {
    for (const [method, path] of [
      ['GET', '/api/config'],
      ['PUT', '/api/config'],
      ['POST', '/api/control'],
      ['GET', '/api/activity/stream'],
      ['GET', '/api/decisions'],
    ]) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status).toBe(404);
    }
  });

  it('rejects malformed, oversized and extra input', async () => {
    for (const [body, status] of [
      ['{', 400],
      [JSON.stringify({ from: 'a', subject: 'b', body: 'c', extra: 'd' }), 400],
      ['x'.repeat(40_000), 413],
    ] as const) {
      const res = await fetch(`${base}/api/try`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(status);
    }
  });
});
