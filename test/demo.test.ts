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
    expect(html).toContain('All activity, account details and usage are examples');
    expect(html).toContain('Start and account actions are unavailable');
    expect(html).not.toContain('/oauth2/sign_out');
    expect(html).toContain('href="/">Home</a>');
    expect(html).toContain('Processing log');
    expect(html).toContain('Recent decisions by category');
    expect(html).toContain("['access','Account']");
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

  it('renders beta sections with isolated synthetic state and a separate mock classifier', async () => {
    const html = await (await fetch(base)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    class Element {
      nodeType = 1;
      children: Element[] = [];
      textContent = '';
      className = '';
      hidden = false;
      disabled = false;
      value = '';
      checked = false;
      style: Record<string, string> = {};
      listeners: Record<string, (event?: { preventDefault: () => void }) => unknown> = {};
      onclick?: () => Promise<void>;
      constructor(public tag: string) {}
      append(...children: Element[]) {
        this.children.push(...children);
      }
      replaceChildren(...children: Element[]) {
        this.children = children;
      }
      setAttribute(key: string, value: string) {
        if (key === 'id') elements[value] = this;
      }
      addEventListener(name: string, fn: (event?: { preventDefault: () => void }) => unknown) {
        this.listeners[name] = fn;
      }
      text(): string {
        return this.textContent + this.children.map((child) => child.text()).join('');
      }
    }
    const elements: Record<string, Element> = Object.fromEntries(
      [
        'mode',
        'run',
        'runbtn',
        'dirty',
        'save',
        'logout',
        'setup',
        'tabs',
        'main',
        'toast',
        'overview',
      ].map((id) => [id, new Element('div')]),
    );
    const calls: { path: string; options: RequestInit }[] = [];
    const context = vm.createContext({
      document: {
        querySelector: (selector: string) => elements[selector.slice(1)],
        createElement: (tag: string) => new Element(tag),
        createTextNode: (text: string) =>
          Object.assign(new Element('#text'), { textContent: text }),
      },
      window: { addEventListener() {} },
      setInterval() {},
      setTimeout() {},
      clearTimeout() {},
      confirm: () => true,
      location: {
        assign() {
          throw new Error('unexpected navigation');
        },
        reload() {
          throw new Error('unexpected reload');
        },
      },
      fetch: async (path: string, options: RequestInit) => {
        calls.push({ path, options });
        if (path !== '/api/try') throw new Error('unexpected real API call');
        return {
          ok: true,
          json: async () => ({ category: 'receipts', confidence: 0.9, reason: 'Mock' }),
        };
      },
    });
    vm.runInContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.main!.text()).toContain('Your order shipped');
    expect(elements.overview!.text()).toContain('Gmail read attempts: 6 / 100');
    expect(elements.runbtn!.disabled).toBe(true);
    expect(elements.logout!.disabled).toBe(true);
    for (const [name, content] of [
      ['Categories', 'Gmail label'],
      ['Rules', 'Checked top to bottom'],
      ['Settings', 'Dry run:'],
      ['Account', 'No Gmail connection in the demo.'],
    ]) {
      elements.tabs!.children.find((item) => item.text() === name)!.listeners.click!();
      expect(elements.main!.text()).toContain(content);
    }
    vm.runInContext("cfg.settings.label_prefix='TEST/';touch()", context);
    await elements.save!.onclick!();
    expect(vm.runInContext('demoConfig.settings.label_prefix', context)).toBe('TEST/');
    expect(calls).toHaveLength(0);
    await expect(vm.runInContext("api('/api/gmail/connect','POST')", context)).rejects.toThrow(
      'Unavailable',
    );
    elements.tabs!.children.find((item) => item.text() === 'Try it')!.listeners.click!();
    const find = (node: Element, tag: string): Element | undefined =>
      node.tag === tag ? node : node.children.map((child) => find(child, tag)).find(Boolean);
    await find(elements.main!, 'form')!.listeners.submit!({ preventDefault() {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/try');
    expect(JSON.parse(String(calls[0]!.options.body))).toEqual({
      from: 'orders@example.com',
      subject: 'Your order shipped',
      body: 'Your synthetic order has shipped.',
    });
    expect(elements['demo-result']!.textContent).toContain('Category: receipts · Confidence: 90%');
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
