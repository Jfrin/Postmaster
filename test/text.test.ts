import { describe, expect, it } from 'vitest';
import { cleanBody, htmlToText, parseAddress, shortenLinks } from '../src/text.js';

describe('text helpers', () => {
  it('strips html, scripts and styles, and decodes entities', () => {
    const html = '<style>p{}</style><p>Hello &amp; welcome</p><script>x()</script><div>Bye</div>';
    const out = htmlToText(html);
    expect(out).toContain('Hello & welcome');
    expect(out).toContain('Bye');
    expect(out).not.toMatch(/x\(\)|p\{\}/);
  });

  it('replaces long links with their host', () => {
    const out = shortenLinks('see https://track.example.com/a/b?c=d&e=f#g now');
    expect(out).toBe('see [link:track.example.com] now');
  });

  it('truncates to the character budget', () => {
    expect(cleanBody('a'.repeat(5000), false, 1500)).toHaveLength(1500);
  });

  it('cleans html input end to end', () => {
    expect(cleanBody('<p>Hi   there</p>', true, 100)).toBe('Hi there');
  });

  it('parses addresses', () => {
    expect(parseAddress('Jane Doe <Jane@Example.COM>')).toEqual({
      address: 'jane@example.com',
      domain: 'example.com',
    });
    expect(parseAddress('plain@x.org').domain).toBe('x.org');
    expect(parseAddress('garbage').domain).toBe('');
  });
});
