import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { cleanBody, parseAddress } from './text.js';
import type { EmailMessage, MailClient, ModifyRequest } from './types.js';

export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

export function oauthClientFromSecrets(secretsDir: string): OAuth2Client {
  const creds = JSON.parse(readFileSync(join(secretsDir, 'credentials.json'), 'utf8'));
  const c = creds.installed ?? creds.web;
  const client = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
  const tokenPath = join(secretsDir, 'token.json');
  client.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf8')));
  // Persist refreshed tokens. Needs a writable secrets mount, so a read-only mount only logs.
  client.on('tokens', (t) => {
    try {
      const current = JSON.parse(readFileSync(tokenPath, 'utf8'));
      writeFileSync(tokenPath, JSON.stringify({ ...current, ...t }, null, 2));
    } catch {
      /* read-only mount: the refresh token itself is unchanged, access token is re-fetched */
    }
  });
  return client;
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Prefer text/plain; fall back to text/html. */
export function extractBody(part: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  isHtml: boolean;
} {
  let plain = '';
  let html = '';
  const walk = (p: gmail_v1.Schema$MessagePart | undefined) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decode(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decode(p.body.data);
    p.parts?.forEach(walk);
  };
  walk(part);
  return plain ? { text: plain, isHtml: false } : { text: html, isHtml: true };
}

export class GmailClient implements MailClient {
  /** Takes the Gmail service so tests can pass a mock. */
  constructor(private readonly gmail: gmail_v1.Gmail) {}

  static fromAuth(auth: OAuth2Client): GmailClient {
    return new GmailClient(google.gmail({ version: 'v1', auth }));
  }

  async ensureLabels(names: string[], create: boolean): Promise<Map<string, string>> {
    const res = await this.gmail.users.labels.list({ userId: 'me' });
    const byName = new Map<string, string>();
    for (const l of res.data.labels ?? []) if (l.name && l.id) byName.set(l.name, l.id);
    const out = new Map<string, string>();
    for (const name of names) {
      let id = byName.get(name);
      if (!id && create) {
        const made = await this.gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          },
        });
        id = made.data.id ?? undefined;
      }
      if (id) out.set(name, id);
    }
    return out;
  }

  async listNew(cursor: string | null, backlogDays: number) {
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    const newCursor = profile.data.historyId ?? cursor ?? '';

    if (cursor) {
      try {
        const ids = new Set<string>();
        let pageToken: string | undefined;
        do {
          const res = await this.gmail.users.history.list({
            userId: 'me',
            startHistoryId: cursor,
            historyTypes: ['messageAdded'],
            labelId: 'INBOX',
            pageToken,
          });
          for (const h of res.data.history ?? []) {
            for (const m of h.messagesAdded ?? []) if (m.message?.id) ids.add(m.message.id);
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return { ids: [...ids], cursor: newCursor };
      } catch (err) {
        // Gmail drops old history (404). Fall through to the recent-mail scan.
        if ((err as { code?: number }).code !== 404) throw err;
      }
    }

    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: `in:inbox newer_than:${backlogDays}d`,
        pageToken,
      });
      for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { ids, cursor: newCursor };
  }

  async fetchMessage(id: string, maxBodyChars: number): Promise<EmailMessage> {
    const res = await this.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const m = res.data;
    const from = header(m, 'From');
    const { address, domain } = parseAddress(from);
    const { text, isHtml } = extractBody(m.payload ?? undefined);
    return {
      id,
      threadId: m.threadId ?? id,
      from,
      address,
      domain,
      subject: header(m, 'Subject'),
      date: header(m, 'Date'),
      hasListUnsubscribe: header(m, 'List-Unsubscribe') !== '',
      body: cleanBody(text, isHtml, maxBodyChars),
      labelIds: m.labelIds ?? [],
    };
  }

  async modify(id: string, change: ModifyRequest): Promise<void> {
    if (!change.add.length && !change.remove.length) return;
    await this.gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds: change.add, removeLabelIds: change.remove },
    });
  }
}
