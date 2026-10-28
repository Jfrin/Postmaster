import { describe, expect, it } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { extractBody, GmailClient } from '../src/gmail.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('extractBody', () => {
  it('prefers text/plain in a multipart message', () => {
    const out = extractBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<b>html</b>') } },
        { mimeType: 'text/plain', body: { data: b64('plain') } },
      ],
    });
    expect(out).toEqual({ text: 'plain', isHtml: false });
  });

  it('falls back to html and finds nested parts', () => {
    const out = extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/html', body: { data: b64('<p>x</p>') } }],
        },
      ],
    });
    expect(out).toEqual({ text: '<p>x</p>', isHtml: true });
  });

  it('copes with an empty payload', () => {
    expect(extractBody(undefined).text).toBe('');
  });
});

describe('GmailClient (mocked Gmail service)', () => {
  type Fn = (...a: never[]) => unknown;
  const make = (u: Record<string, Record<string, Fn>>) =>
    new GmailClient({ users: u } as unknown as gmail_v1.Gmail);

  it('ensureLabels returns existing ids and creates only when asked', async () => {
    const created: string[] = [];
    const client = make({
      labels: {
        list: (async () => ({ data: { labels: [{ name: 'AI/Dev', id: 'L1' }] } })) as Fn,
        create: (async (a: { requestBody: { name: string } }) => {
          created.push(a.requestBody.name);
          return { data: { id: 'L2' } };
        }) as Fn,
      },
    });
    const noCreate = await client.ensureLabels(['AI/Dev', 'AI/New'], false);
    expect([...noCreate]).toEqual([['AI/Dev', 'L1']]);
    expect(created).toEqual([]);
    const withCreate = await client.ensureLabels(['AI/Dev', 'AI/New'], true);
    expect(withCreate.get('AI/New')).toBe('L2');
    expect(created).toEqual(['AI/New']);
  });

  it('listNew uses history when there is a cursor, de-duplicating ids', async () => {
    const client = make({
      getProfile: (async () => ({ data: { historyId: '200' } })) as Fn,
      history: {
        list: (async () => ({
          data: {
            history: [
              { messagesAdded: [{ message: { id: 'a' } }] },
              { messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] },
            ],
          },
        })) as Fn,
      },
    } as never);
    expect(await client.listNew('100', 7)).toEqual({ ids: ['a', 'b'], cursor: '200' });
  });

  it('listNew falls back to a recent-mail scan when history has expired (404)', async () => {
    const client = make({
      getProfile: (async () => ({ data: { historyId: '300' } })) as Fn,
      history: {
        list: (async () => {
          throw Object.assign(new Error('gone'), { code: 404 });
        }) as Fn,
      },
      messages: { list: (async () => ({ data: { messages: [{ id: 'z' }] } })) as Fn },
    } as never);
    expect(await client.listNew('1', 7)).toEqual({ ids: ['z'], cursor: '300' });
  });

  it('listNew with no cursor scans the backlog window', async () => {
    let query = '';
    const client = make({
      getProfile: (async () => ({ data: { historyId: '5' } })) as Fn,
      messages: {
        list: (async (a: { q: string }) => {
          query = a.q;
          return { data: { messages: [{ id: 'm' }] } };
        }) as Fn,
      },
    } as never);
    await client.listNew(null, 3);
    expect(query).toContain('newer_than:3d');
  });

  it('fetchMessage parses headers and cleans the body', async () => {
    const client = make({
      messages: {
        get: (async () => ({
          data: {
            threadId: 't9',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'From', value: 'Shop <Orders@Shop.com>' },
                { name: 'Subject', value: 'Shipped' },
                { name: 'List-Unsubscribe', value: '<mailto:x>' },
              ],
              mimeType: 'text/plain',
              body: { data: b64('see https://t.example.com/very/long/link') },
            },
          },
        })) as Fn,
      },
    } as never);
    const m = await client.fetchMessage('m1', 1500);
    expect(m).toMatchObject({
      threadId: 't9',
      address: 'orders@shop.com',
      hasListUnsubscribe: true,
      body: 'see [link:t.example.com]',
    });
  });

  it('modify skips empty changes and sends add/remove ids otherwise', async () => {
    const calls: unknown[] = [];
    const client = make({
      messages: { modify: (async (a: unknown) => void calls.push(a)) as Fn },
    } as never);
    await client.modify('m', { add: [], remove: [] });
    expect(calls).toHaveLength(0);
    await client.modify('m', { add: ['L'], remove: ['INBOX'] });
    expect(calls[0]).toMatchObject({
      requestBody: { addLabelIds: ['L'], removeLabelIds: ['INBOX'] },
    });
  });
});
