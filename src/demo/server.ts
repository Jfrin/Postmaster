import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { MockClassifier } from '../classifier.js';
import type { Config } from '../config.js';
import { matchRule } from '../rules.js';
import { cleanBody, parseAddress } from '../text.js';
import type { EmailMessage } from '../types.js';
import { DEMO_PAGE } from './page.js';

const Input = z
  .object({
    from: z.string().min(1).max(500),
    subject: z.string().min(1).max(1000),
    body: z.string().min(1).max(20000),
  })
  .strict();

function respond(res: ServerResponse, code: number, body: string, contentType: string): void {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  origin: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    return respond(res, 200, DEMO_PAGE, 'text/html; charset=utf-8');
  }
  if (req.method !== 'POST' || url.pathname !== '/api/try') {
    return respond(res, 404, '{"error":"not found"}', 'application/json');
  }
  if (
    req.headers.origin !== origin ||
    !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')
  ) {
    return respond(res, 403, '{"error":"forbidden"}', 'application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32_768) return respond(res, 413, '{"error":"too large"}', 'application/json');
    chunks.push(chunk as Buffer);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return respond(res, 400, '{"error":"invalid input"}', 'application/json');
  }
  const parsed = Input.safeParse(input);
  if (!parsed.success) return respond(res, 400, '{"error":"invalid input"}', 'application/json');
  const message: EmailMessage = {
    id: 'synthetic',
    threadId: 'synthetic',
    from: parsed.data.from,
    ...parseAddress(parsed.data.from),
    subject: parsed.data.subject,
    date: '',
    hasListUnsubscribe: false,
    body: cleanBody(parsed.data.body, false, config.settings.max_body_chars),
    labelIds: [],
  };
  const rule = matchRule(config.rules, message);
  const result = rule
    ? { category: rule.category, confidence: 1, reason: 'Matched a rule.' }
    : await new MockClassifier().classify(message, config.categories);
  const category =
    result.confidence < config.settings.confidence_threshold
      ? config.settings.fallback_category
      : result.category;
  return respond(res, 200, JSON.stringify({ ...result, category }), 'application/json');
}

/** Only deploy behind an authentication proxy, never publish this server directly. */
export function createDemoServer(config: Config, origin: string): Server {
  return createServer((req, res) => {
    handle(req, res, config, origin).catch(() =>
      respond(res, 500, '{"error":"internal error"}', 'application/json'),
    );
  });
}
