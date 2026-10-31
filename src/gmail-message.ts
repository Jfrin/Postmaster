import type { gmail_v1 } from '@googleapis/gmail';
import { cleanBody, parseAddress } from './text.js';
import type { EmailMessage } from './types.js';

/** Prefer the first text/plain part; fall back to the first text/html part. */
export function extractBody(part: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  isHtml: boolean;
} {
  let plain = '';
  let html = '';
  const walk = (current: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!current) return;
    if (current.mimeType === 'text/plain' && current.body?.data && !plain) {
      plain = Buffer.from(current.body.data, 'base64url').toString('utf8');
    } else if (current.mimeType === 'text/html' && current.body?.data && !html) {
      html = Buffer.from(current.body.data, 'base64url').toString('utf8');
    }
    current.parts?.forEach(walk);
  };
  walk(part);
  return plain ? { text: plain, isHtml: false } : { text: html, isHtml: true };
}

/** Convert a Gmail response into the application's normalized message format. */
export function parseGmailMessage(
  id: string,
  message: gmail_v1.Schema$Message,
  maxBodyChars: number,
): EmailMessage {
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    const name = header.name?.toLowerCase();
    if (name && !headers.has(name)) headers.set(name, header.value ?? '');
  }
  const from = headers.get('from') ?? '';
  const { text, isHtml } = extractBody(message.payload ?? undefined);
  return {
    id,
    threadId: message.threadId ?? id,
    from,
    ...parseAddress(from),
    subject: headers.get('subject') ?? '',
    date: headers.get('date') ?? '',
    hasListUnsubscribe: (headers.get('list-unsubscribe') ?? '') !== '',
    body: cleanBody(text, isHtml, maxBodyChars),
    labelIds: message.labelIds ?? [],
  };
}
