import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BETA_ADMIN_PAGE } from '../src/beta/admin-page.js';

class Element {
  nodeType = 1;
  children: Element[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {};
  value = '';
  textContent = '';
  disabled = false;
  className = '';
  constructor(public tag: string) {}
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(name: string, handler: () => unknown) {
    this.listeners[name] = handler;
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('');
  }
  find(tag: string): Element[] {
    return [
      ...(this.tag === tag ? [this] : []),
      ...this.children.flatMap((child) => child.find(tag)),
    ];
  }
}

describe('application admin UI', () => {
  it('filters, paginates and clamps the current page after deleting', async () => {
    const roots = Object.fromEntries(
      [
        'application-search',
        'applications',
        'application-pages',
        'application-error',
        'dashboard',
        'intake',
        'notification-status',
        'summary',
        'requests',
        'error',
      ].map((id) => [id, new Element('root')]),
    );
    const items = Array.from({ length: 21 }, (_, i) => ({
      email: `user${String(i).padStart(2, '0')}@example.com`,
      status: i === 20 ? 'denied' : 'pending',
      dailyLimit: 7,
      expiresAt: null,
    }));
    const calls: { path: string; body: string }[] = [];
    const context = vm.createContext({
      document: {
        querySelector: (selector: string) => roots[selector.slice(1)],
        createElement: (tag: string) => new Element(tag),
        createTextNode: (text: string) => {
          const node = new Element('#text');
          node.textContent = text;
          return node;
        },
      },
      confirm: () => true,
      fetch: async (path: string, options: { body?: string }) => {
        if (options.body) calls.push({ path, body: options.body });
        if (path.endsWith('/delete-application')) items.pop();
        return {
          ok: true,
          json: async () =>
            path.endsWith('/applications')
              ? items
              : path.endsWith('/session')
                ? { isAdmin: true, csrfToken: 'token' }
                : path.endsWith('/requests')
                  ? []
                  : {},
        };
      },
    });
    const script = BETA_ADMIN_PAGE.match(/<script>([\s\S]*?)<\/script>/)![1]!
      .replace('__BETA_BASE_PATH__', "'/beta'")
      .replace('refresh();refreshApplications();notificationStatus();', '');
    vm.runInContext(script, context);
    context.applicationItems = items;
    context.session = { isAdmin: true, csrfToken: 'token' };
    vm.runInContext('renderApplications()', context);
    expect(roots.applications!.find('tr')).toHaveLength(11);
    expect(roots['application-pages']!.text()).toContain('Page 1 of 3');
    roots['application-pages']!.find('button')[1]!.listeners.click!();
    roots['application-pages']!.find('button')[1]!.listeners.click!();
    expect(roots.applications!.text()).toContain('user20@example.com');
    await roots.applications!.find('button').find((button) => button.text() === 'Delete')!.listeners
      .click!();
    expect(calls[0]).toEqual({
      path: '/beta/api/admin/delete-application',
      body: '{"email":"user20@example.com"}',
    });
    expect(roots['application-pages']!.text()).toContain('Page 2 of 2');
    roots['application-search']!.value = 'USER01';
    roots['application-search']!.listeners.input!();
    expect(roots.applications!.text()).toContain('user01@example.com');
    expect(roots.applications!.text()).not.toContain('user02@example.com');
    expect(roots['application-pages']!.text()).toContain('Page 1 of 1');
    roots['application-search']!.value = 'missing';
    roots['application-search']!.listeners.input!();
    expect(roots.applications!.text()).toContain('No applications match');
  });
});
