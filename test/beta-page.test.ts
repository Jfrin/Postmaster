import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BETA_PAGE } from '../src/beta/page.js';

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
  onclick?: () => unknown;
  listeners: Record<string, () => unknown> = {};
  constructor(public tag: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute() {}
  addEventListener(name: string, callback: () => unknown) {
    this.listeners[name] = callback;
  }
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('');
  }
}

describe('beta dashboard', () => {
  it('renders real scoped events and decisions and navigates the admin dashboard', async () => {
    const elements = Object.fromEntries(
      ['mode', 'run', 'runbtn', 'dirty', 'save', 'logout', 'tabs', 'main', 'toast'].map((id) => [
        id,
        new Element('div'),
      ]),
    );
    const session = {
      email: 'alice@example.com',
      csrfToken: 'x'.repeat(32),
      isAdmin: true,
      request: { active: true, status: 'approved', expiresAt: Date.now() + 60_000 },
      gmailReady: true,
      gmailConnected: true,
      gmailAvailable: true,
      configAvailable: true,
      processingOnline: true,
      processingRequested: false,
    };
    const config = { settings: { dry_run: true }, categories: [], rules: [] };
    const replies: Record<string, unknown> = {
      '/beta/api/session': session,
      '/beta/api/config': config,
      '/beta/api/activity': [
        { created_at: '2026-11-04T10:00:00Z', subject: '<img>', category: 'work', confidence: 1 },
      ],
      '/beta/api/processing/events': [
        { occurred_at: 3, event: 'cycle_failed', status: 403 },
        { occurred_at: 2, event: 'cycle_progress', seen: 10, processed: 1 },
        { occurred_at: 1, event: 'cycle_started' },
      ],
      '/beta/api/admin/metrics': {},
      '/beta/api/admin/requests': [],
    };
    const document = {
      querySelector: (selector: string) => elements[selector.slice(1)],
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
    };
    const script = BETA_PAGE.replace('__BETA_BASE_PATH__', '"/beta"').match(
      /<script>([\s\S]*?)<\/script>/,
    )![1]!;
    const context = vm.createContext({
      document,
      window: { addEventListener() {} },
      fetch: async (url: string) => ({ ok: true, json: async () => replies[url] }),
      setInterval() {},
      setTimeout() {},
      clearTimeout() {},
      confirm: () => true,
      location: { reload() {}, assign() {} },
    });
    vm.runInContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.main!.text()).toContain('Scan failed (HTTP 403)');
    expect(elements.main!.text()).toContain(
      'Checked 1 / 10 messages (includes skipped and failed)',
    );
    expect(elements.main!.text().indexOf('Scan started')).toBeLessThan(
      elements.main!.text().indexOf('Scan failed'),
    );
    expect(elements.main!.text()).toContain('ERROR');
    expect(elements.main!.text()).toContain('<img>');
    expect(elements.tabs!.text()).toContain('Admin');
    const admin = elements.tabs!.children.find((child) => child.text() === 'Admin');
    expect(admin).toBeDefined();
    admin!.listeners.click!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.main!.text()).toContain('Admin dashboard');
    expect(elements.mode!.textContent).toContain('DRY RUN');
  });
});
