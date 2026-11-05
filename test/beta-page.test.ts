import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BETA_PAGE } from '../src/beta/page.js';
import { BETA_ADMIN_PAGE } from '../src/beta/admin-page.js';

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
  it('renders real scoped events and decisions without admin navigation', async () => {
    const elements = Object.fromEntries(
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
      dataDeletionAvailable: true,
      usage: { attempts: 2, limit: 100, processed: 1, failed: 0 },
    };
    const config = { settings: { dry_run: true }, categories: [], rules: [] };
    const replies: Record<string, unknown> = {
      '/beta/api/session': session,
      '/beta/api/config': config,
      '/beta/api/activity': [
        { created_at: '2026-11-04T10:00:00Z', subject: '<img>', category: 'work', confidence: 1 },
      ],
      '/beta/api/processing/events': [
        { occurred_at: 4, event: 'backlog_completed' },
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
    const calls: { url: string; options: { method?: string; body?: string } }[] = [];
    const script = BETA_PAGE.replace('__BETA_BASE_PATH__', '"/beta"').match(
      /<script>([\s\S]*?)<\/script>/,
    )![1]!;
    const context = vm.createContext({
      document,
      window: { addEventListener() {} },
      fetch: async (url: string, options: { method?: string; body?: string }) => {
        calls.push({ url, options });
        return { ok: true, json: async () => replies[url] ?? {} };
      },
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
    expect(elements.main!.text()).toContain(
      'Backlog scan complete. Postmaster will keep checking for new email',
    );
    expect(BETA_PAGE).toContain('Changes apply on the next scan; no restart is required');
    expect(elements.main!.text()).toContain('<img>');
    expect(elements.overview!.text()).toContain('Gmail read attempts: 2 / 100');
    expect(elements.overview!.text()).toContain('latest 1 decisions');
    expect(elements.tabs!.text()).not.toContain('Admin');
    expect(elements.tabs!.text()).toContain('Account');
    expect(elements.setup!.hidden).toBe(true);
    session.processingRequested = true;
    session.processingOnline = false;
    session.gmailReady = false;
    session.configAvailable = false;
    await vm.runInContext('refresh()', context);
    expect(elements.run!.textContent).toBe('Poller offline; processing requested');
    expect(elements.runbtn!.textContent).toBe('Stop');
    expect(elements.runbtn!.disabled).toBe(false);
    await elements.runbtn!.onclick!();
    expect(calls.some((call) => call.url === '/beta/api/processing/stop')).toBe(true);
    session.processingRequested = false;
    await vm.runInContext('refresh()', context);
    expect(elements.runbtn!.disabled).toBe(true);
    session.processingOnline = true;
    session.configAvailable = true;
    session.gmailReady = false;
    session.gmailConnected = false;
    await vm.runInContext('refresh()', context);
    expect(elements.setup!.hidden).toBe(false);
    expect(elements.setup!.text()).toContain('Signing in does not connect your inbox');
    expect(elements.setup!.text()).toContain('Connect Gmail');
    expect(elements.setup!.text()).toContain('Nothing runs automatically');
    const goToAccount = elements.setup!.children.find((child) => child.text() === 'Go to Account');
    expect(goToAccount).toBeDefined();
    goToAccount!.listeners.click!();
    expect(elements.main!.text()).toContain('Gmail is not connected');
    expect(elements.main!.text()).not.toContain('Google account for saved Gmail connection');
    expect(elements.main!.text()).toContain('Connect Gmail');
    session.gmailConnected = true;
    await vm.runInContext('refresh()', context);
    expect(elements.setup!.text()).toContain('saved Gmail connection is not ready');
    expect(elements.main!.text()).toContain('Google account for saved Gmail connection');
    expect(elements.main!.text()).toContain('alice@example.com');
    expect(elements.main!.text()).toContain('saved grant may need reconnecting');
    session.gmailReady = true;
    await vm.runInContext('refresh()', context);
    expect(elements.setup!.hidden).toBe(true);
    expect(BETA_PAGE).toContain('href="/">Home</a>');
    expect(BETA_PAGE).toContain('href="/privacy">Privacy</a>');
    expect(BETA_PAGE).toContain('href="/terms">Terms</a>');
    const account = elements.tabs!.children.find((child) => child.text() === 'Account');
    expect(account).toBeDefined();
    account!.listeners.click!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.main!.text()).toContain('Gmail connection');
    expect(elements.main!.text()).toContain('Daily Gmail read-attempt limit: 100');
    expect(elements.main!.text()).toContain('Used today: 2');
    expect(elements.main!.text()).toContain('Remaining: 98');
    expect(elements.main!.text()).toContain('Approval and Start are still required');
    expect(elements.main!.text()).toContain('Delete email content data');
    expect(elements.main!.text()).toContain('Delete decision cache data');
    expect(elements.main!.text()).toContain('Delete other account data');
    expect(elements.main!.text()).toContain('Delete all data');
    expect(elements.main!.text()).toContain('Delete account');
    expect(elements.main!.text()).toContain('Existing backups are not erased');
    expect(elements.main!.text()).toContain('Categories and identifiers can still be sensitive');
    const findButton = (node: Element, text: string): Element | undefined =>
      node.tag === 'button' && node.text() === text
        ? node
        : node.children.map((child) => findButton(child, text)).find(Boolean);
    await findButton(elements.main!, 'Delete email content data')!.listeners.click!();
    expect(
      JSON.parse(calls.find((call) => call.url === '/beta/api/data/delete')!.options.body!),
    ).toEqual({ scope: 'content', confirm: true });
    session.usage.attempts = 3;
    await vm.runInContext('refresh()', context);
    expect(elements.main!.text()).toContain('Used today: 3');
    expect(elements.main!.text()).toContain('Remaining: 97');
    expect(elements.mode!.textContent).toContain('DRY RUN');
    vm.runInContext("cfg.rules=[{match:{from:''},category:'work'}];dirty=true", context);
    await elements.save!.onclick!();
    expect(elements.toast!.textContent).toContain('Each rule needs a sender, domain, or subject');
    expect(vm.runInContext('cfg.rules.length', context)).toBe(1);
  });

  it('renders requests safely on the separate admin page and sends CSRF-protected decisions', async () => {
    const elements = Object.fromEntries(
      [
        'dashboard',
        'intake',
        'summary',
        'error',
        'requests',
        'applications',
        'application-error',
        'application-search',
        'application-pages',
        'notification-status',
      ].map((id) => [id, new Element('div')]),
    );
    const calls: {
      url: string;
      opts: { method: string; headers: Record<string, string>; body?: string };
    }[] = [];
    const replies: Record<string, unknown> = {
      '/beta/api/session': { isAdmin: true, csrfToken: 'x'.repeat(32) },
      '/beta/api/admin/metrics': {
        pending: 1,
        active: 0,
        expired: 0,
        denied: 0,
        readsToday: 0,
        processedToday: 0,
        failedToday: 0,
      },
      '/beta/api/admin/notifications': { enabled: true, pending: 1, failed: 0, failures: [] },
      '/beta/api/admin/requests': [
        {
          subject: 'alice',
          email: '<alice>',
          status: 'pending',
          active: false,
          expiresAt: null,
          attempts: 0,
          dailyLimit: 100,
          cycleUsage: { processed: 0, failed: 0 },
        },
      ],
      '/beta/api/admin/deny': { ok: true },
      '/beta/api/admin/applications': [
        { email: 'applicant@gmail.com', status: 'pending', expiresAt: null, dailyLimit: 100 },
      ],
      '/beta/api/admin/application-decision': { ok: true },
    };
    const document = {
      querySelector: (selector: string) => elements[selector.slice(1)],
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
    };
    const script = BETA_ADMIN_PAGE.replace('__BETA_BASE_PATH__', '"/beta"').match(
      /<script>([\s\S]*?)<\/script>/,
    )![1]!;
    vm.runInContext(
      script,
      vm.createContext({
        document,
        confirm: () => true,
        fetch: async (
          url: string,
          opts: { method: string; headers: Record<string, string>; body?: string },
        ) => {
          calls.push({ url, opts });
          return { ok: true, json: async () => replies[url] };
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(elements.requests!.text()).toContain('<alice>');
    const find = (node: Element, text: string): Element | undefined =>
      node.tag === 'button' && node.text() === text
        ? node
        : node.children.map((x) => find(x, text)).find(Boolean);
    const deny = find(elements.requests!, 'Deny');
    expect(deny).toBeDefined();
    await deny!.listeners.click!();
    expect(calls.find((c) => c.url.endsWith('/api/admin/deny'))?.opts.headers['X-CSRF-Token']).toBe(
      'x'.repeat(32),
    );
    expect(elements.applications!.text()).toContain('applicant@gmail.com');
    const inputs = (node: Element): Element[] => [
      ...(node.tag === 'input' ? [node] : []),
      ...node.children.flatMap(inputs),
    ];
    inputs(elements.applications!)[1]!.value = '2026-12-01T12:00';
    const approve = find(elements.applications!, 'Approve');
    expect(approve).toBeDefined();
    await approve!.listeners.click!();
    const decision = calls.find((c) => c.url.endsWith('/api/admin/application-decision'));
    expect(decision?.opts.headers['X-CSRF-Token']).toBe('x'.repeat(32));
    expect(JSON.parse(decision!.opts.body!)).toMatchObject({
      email: 'applicant@gmail.com',
      status: 'approved',
      dailyLimit: 100,
    });
  });
});
