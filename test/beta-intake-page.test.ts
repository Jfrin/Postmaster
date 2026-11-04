import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BETA_INTAKE_PAGE } from '../src/beta/intake-page.js';

describe('public beta application page', () => {
  it('shows success after the submit event has finished dispatching', async () => {
    expect(BETA_INTAKE_PAGE).toContain('href="/">Home</a>');
    const message = { textContent: '' };
    const email = { value: ' applicant@gmail.com ' };
    const button = { disabled: false };
    const link = { href: '' };
    let handler: (event: {
      preventDefault(): void;
      currentTarget: typeof form | null;
    }) => Promise<void>;
    let reset = false;
    const form = {
      addEventListener: (_name: string, listener: typeof handler) => {
        handler = listener;
      },
      querySelector: () => button,
      reset: () => {
        reset = true;
      },
    };
    const elements: Record<string, unknown> = {
      '#apply': form,
      '#message': message,
      '#email': email,
      '#signin': link,
    };
    let sent = '';
    const script = BETA_INTAKE_PAGE.replace('__BETA_BASE_PATH__', '"/beta"').match(
      /<script>([\s\S]*?)<\/script>/,
    )![1]!;
    vm.runInNewContext(script, {
      document: { querySelector: (selector: string) => elements[selector] },
      fetch: async (_url: string, options: { body: string }) => {
        sent = options.body;
        return { ok: true };
      },
    });
    const event: { preventDefault(): void; currentTarget: typeof form | null } = {
      preventDefault() {},
      currentTarget: form,
    };
    const result = handler!(event);
    event.currentTarget = null;
    await result;
    expect(JSON.parse(sent)).toEqual({ email: 'applicant@gmail.com' });
    expect(reset).toBe(true);
    expect(message.textContent).toBe('Application received. Thank you.');
    expect(button.disabled).toBe(false);
    expect(link.href).toBe('/beta/');
  });
});
