import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BETA_INTAKE_PAGE } from '../src/beta/intake-page.js';

describe('public beta application page', () => {
  it('submits the application without a verification step', async () => {
    const handlers: Record<
      string,
      (event: { preventDefault(): void; currentTarget: unknown }) => Promise<void>
    > = {};
    const button = { disabled: false };
    const form = (name: string) => ({
      addEventListener: (_: string, handler: (typeof handlers)[string]) => {
        handlers[name] = handler;
      },
      querySelector: () => button,
      reset() {},
    });
    const apply = form('apply');
    const email = { value: ' applicant@gmail.com ' };
    const message = { textContent: '' };
    const link = { href: '' };
    const elements: Record<string, unknown> = {
      '#apply': apply,
      '#email': email,
      '#message': message,
      '#signin': link,
    };
    const calls: { url: string; body: unknown }[] = [];
    const script = BETA_INTAKE_PAGE.replace('__BETA_BASE_PATH__', '"/beta"').match(
      /<script>([\s\S]*?)<\/script>/,
    )![1]!;
    vm.runInNewContext(script, {
      document: { querySelector: (selector: string) => elements[selector] },
      fetch: async (url: string, options: { body: string }) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true };
      },
    });
    await handlers.apply!({ preventDefault() {}, currentTarget: apply });
    expect(calls[0]).toEqual({ url: '/beta/api/apply', body: { email: 'applicant@gmail.com' } });
    expect(message.textContent).toContain('If eligible');
    expect(calls).toHaveLength(1);
    expect(BETA_INTAKE_PAGE).not.toContain('verification code');
    expect(button.disabled).toBe(false);
    expect(link.href).toBe('/beta/');
  });
});
