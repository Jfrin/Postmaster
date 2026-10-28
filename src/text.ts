const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** Replace URLs with just their host so long tracking links do not eat the token budget. */
export function shortenLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s<>)"']+/gi, (url) => {
    try {
      return `[link:${new URL(url).hostname}]`;
    } catch {
      return '[link]';
    }
  });
}

export function cleanBody(raw: string, isHtml: boolean, maxChars: number): string {
  const text = shortenLinks(isHtml ? htmlToText(raw) : raw)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** "Jane <Jane@Example.com>" -> { address: "jane@example.com", domain: "example.com" } */
export function parseAddress(from: string): { address: string; domain: string } {
  const angle = /<([^>]+)>/.exec(from);
  const address = (angle?.[1] ?? from).trim().toLowerCase();
  const domain = address.includes('@') ? (address.split('@').pop() ?? '') : '';
  return { address, domain };
}
