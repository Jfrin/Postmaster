import { describe, expect, it } from 'vitest';
import {
  AzureClassifier,
  ContentFilteredError,
  InvalidModelOutputError,
  MockClassifier,
  parseModelOutput,
  responseSchema,
  systemPrompt,
  userPrompt,
  type ChatClient,
} from '../src/classifier.js';
import { makeConfig, makeMessage } from './helpers.js';

const cats = makeConfig().categories;

function fakeClient(
  replies: (string | null)[],
): ChatClient & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    chat: {
      completions: {
        create: (args) => {
          requests.push(args);
          return Promise.resolve({ choices: [{ message: { content: replies.shift() ?? null } }] });
        },
      },
    },
  };
}

describe('prompt building', () => {
  it('builds the system prompt from the category list', () => {
    const p = systemPrompt(cats);
    expect(p).toContain('- receipts: Orders');
    expect(p).toContain('untrusted');
  });

  it('includes sender, subject, unsubscribe flag and body, nothing else', () => {
    const p = userPrompt(makeMessage({ hasListUnsubscribe: true }));
    expect(p).toContain('From: Shop <orders@shop.example>');
    expect(p).toContain('List-Unsubscribe header: yes');
  });

  it('restricts category to configured ids', () => {
    expect(responseSchema(cats).properties.category.enum).toEqual([
      'receipts',
      'dev',
      'needs_review',
    ]);
  });
});

describe('parseModelOutput', () => {
  it('accepts valid output', () => {
    const out = parseModelOutput('{"category":"dev","confidence":0.8,"reason":"x"}', cats);
    expect(out.category).toBe('dev');
  });

  it.each([
    [
      'unknown category (prompt injection cannot invent one)',
      '{"category":"delete_all","confidence":1,"reason":""}',
    ],
    ['confidence out of range', '{"category":"dev","confidence":3,"reason":""}'],
    ['not json', 'sure! it is dev'],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseModelOutput(raw, cats)).toThrow();
  });
});

describe('AzureClassifier', () => {
  const good = '{"category":"receipts","confidence":0.93,"reason":"shipping"}';

  it('calls the model at temperature 0 with a strict json schema', async () => {
    const client = fakeClient([good]);
    const out = await new AzureClassifier(client, 'dep').classify(makeMessage(), cats);
    expect(out.category).toBe('receipts');
    expect(client.requests[0]).toMatchObject({ model: 'dep', temperature: 0 });
    expect(JSON.stringify(client.requests[0])).toContain('"strict":true');
  });

  it('retries once on invalid output', async () => {
    const client = fakeClient(['nope', good]);
    const out = await new AzureClassifier(client, 'dep').classify(makeMessage(), cats);
    expect(out.confidence).toBe(0.93);
    expect(client.requests).toHaveLength(2);
  });

  it('throws after two invalid replies', async () => {
    const client = fakeClient(['nope', null]);
    await expect(new AzureClassifier(client, 'dep').classify(makeMessage(), cats)).rejects.toThrow(
      InvalidModelOutputError,
    );
  });

  it.each([
    { status: 400, code: 'content_filter' },
    { status: 400, error: { code: 'content_filter' } },
  ])('recognizes structured Azure content filter errors: %j', async (details) => {
    const error = Object.assign(new Error('blocked'), details);
    const client: ChatClient = { chat: { completions: { create: () => Promise.reject(error) } } };
    await expect(new AzureClassifier(client, 'dep').classify(makeMessage(), cats)).rejects.toThrow(
      ContentFilteredError,
    );
  });

  it('recognizes a filtered completion without retrying', async () => {
    let calls = 0;
    const client: ChatClient = {
      chat: {
        completions: {
          create: () => {
            calls++;
            return Promise.resolve({
              choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
            });
          },
        },
      },
    };
    await expect(new AzureClassifier(client, 'dep').classify(makeMessage(), cats)).rejects.toThrow(
      ContentFilteredError,
    );
    expect(calls).toBe(1);
  });

  it.each([
    { status: 400, code: 'invalid_request_error' },
    { status: 429, code: 'content_filter' },
    { status: 400 },
  ])('does not mistake other API errors for content filtering: %j', async (details) => {
    const error = Object.assign(new Error('content filter'), details);
    const client: ChatClient = { chat: { completions: { create: () => Promise.reject(error) } } };
    await expect(new AzureClassifier(client, 'dep').classify(makeMessage(), cats)).rejects.toBe(
      error,
    );
  });

  it('explains a 404 by naming the deployment and endpoint', async () => {
    const client: ChatClient = {
      chat: {
        completions: {
          create: () => Promise.reject(Object.assign(new Error('x'), { status: 404 })),
        },
      },
    };
    const err = await new AzureClassifier(client, 'my-dep', 'https://r.openai.azure.com')
      .classify(makeMessage(), cats)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(InvalidModelOutputError);
    expect(String(err)).toMatch(/my-dep.*https:\/\/r\.openai\.azure\.com.*deployment name/s);
  });

  it('explains a rejected key and passes other errors through', async () => {
    const make = (e: unknown): ChatClient => ({
      chat: { completions: { create: () => Promise.reject(e) } },
    });
    const auth = new AzureClassifier(make(Object.assign(new Error('x'), { status: 401 })), 'd');
    await expect(auth.classify(makeMessage(), cats)).rejects.toThrow(/API key was rejected/);
    const net = new AzureClassifier(make(new Error('socket hang up')), 'd');
    await expect(net.classify(makeMessage(), cats)).rejects.toThrow('socket hang up');
    const odd = new AzureClassifier(make('string failure'), 'd');
    await expect(odd.classify(makeMessage(), cats)).rejects.toThrow('string failure');
  });

  it('fromEnv demands the three Azure variables', () => {
    expect(() => AzureClassifier.fromEnv({})).toThrow(/AZURE_OPENAI_ENDPOINT/);
    expect(() =>
      AzureClassifier.fromEnv({
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
        AZURE_OPENAI_API_KEY: 'k',
        AZURE_OPENAI_DEPLOYMENT: 'd',
      }),
    ).not.toThrow();
  });
});

describe('MockClassifier', () => {
  it('matches keywords and falls back with low confidence', async () => {
    const m = new MockClassifier();
    expect((await m.classify(makeMessage(), cats)).category).toBe('receipts');
    const none = await m.classify(makeMessage({ subject: 'hi', body: 'hello' }), cats);
    expect(none.confidence).toBeLessThan(0.5);
  });
});
