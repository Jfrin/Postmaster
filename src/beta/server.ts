import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ConfigSchema } from '../config.js';
import { AccessDeniedError, type BetaAccessStore } from './access.js';
import type { GmailConsentFlow } from './gmail-consent-flow.js';
import { GmailConsentStateStore } from './gmail-consent-state.js';
import type { IdentityFlow } from './identity-flow.js';
import { IdentityLoginStateStore } from './oauth-state.js';
import { BETA_PAGE } from './page.js';
import type { BetaUserConfigStore } from './user-config.js';

/** A trusted server-side session adapter must supply these from a verified Google identity. */
export interface BetaSession {
  subject: string;
  verifiedEmail: string;
  csrfToken: string;
}

export interface BetaServerOptions {
  store: BetaAccessStore;
  origin: string;
  /** Must validate an opaque, expiring session cookie; never trust client identity headers. */
  authenticate: (req: IncomingMessage) => Promise<BetaSession | null>;
  /** Optional until Google identity is configured. Gmail consent remains separate. */
  identityFlow?: IdentityFlow;
  /** Only enable after Gmail policy, key management and isolation checks are complete. */
  gmailConsentFlow?: GmailConsentFlow;
  userConfigStore?: BetaUserConfigStore;
  now?: () => number;
}

const Subject = z
  .string()
  .min(1)
  .max(255)
  .refine((x) => x.trim() === x);
const Approval = z
  .object({
    subject: Subject,
    expiresAt: z.number().int().nonnegative(),
    dailyLimit: z.number().int().min(0).max(100_000),
  })
  .strict();
const Denial = z.object({ subject: Subject }).strict();
const Request = z.object({}).strict();
class RequestTooLargeError extends Error {}
class SessionExpiredError extends Error {}

function send(res: ServerResponse, status: number, data: unknown, html = false): void {
  res.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html ? String(data) : JSON.stringify(data));
}

function matchesCsrf(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length < 32 || expected.length > 256) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += (chunk as Buffer).length;
    if (length > 131_072) throw new RequestTooLargeError('request too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function readAuthorizedJson(
  options: BetaServerOptions,
  req: IncomingMessage,
  session: BetaSession,
): Promise<unknown> {
  const body = await readJson(req);
  const current = await options.authenticate(req);
  if (!current || current.subject !== session.subject || current.csrfToken !== session.csrfToken) {
    throw new SessionExpiredError('session no longer valid');
  }
  return body;
}

async function handle(
  options: BetaServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const expectedHost = new URL(options.origin).host;
  if (req.headers.host !== expectedHost) return send(res, 403, { error: 'forbidden' });
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', options.origin);
  const now = options.now?.() ?? Date.now();
  if (method === 'GET' && url.pathname === '/auth/google/start' && options.identityFlow) {
    const start = options.identityFlow.start(now);
    res.writeHead(302, {
      Location: start.location,
      'Set-Cookie': start.cookie,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }
  if (method === 'GET' && url.pathname === '/auth/google/callback' && options.identityFlow) {
    const states = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    if (states.length !== 1 || codes.length !== 1)
      return send(res, 400, { error: 'invalid sign-in response' });
    try {
      const cookie = await options.identityFlow.finish(
        states[0]!,
        codes[0]!,
        req.headers.cookie,
        now,
      );
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [IdentityLoginStateStore.clearCookie(), cookie],
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    } catch {
      res.setHeader('Set-Cookie', IdentityLoginStateStore.clearCookie());
      return send(res, 401, { error: 'sign-in failed' });
    }
  }
  const session = await options.authenticate(req);
  if (
    !session ||
    !Subject.safeParse(session.subject).success ||
    !session.verifiedEmail ||
    session.verifiedEmail.length > 320 ||
    /[\r\n]/.test(session.verifiedEmail) ||
    session.csrfToken.length < 32 ||
    session.csrfToken.length > 256
  ) {
    if (method === 'GET' && url.pathname === '/' && options.identityFlow) {
      res.writeHead(302, { Location: '/auth/google/start', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    return send(res, 401, { error: 'authentication required' });
  }
  if (
    method === 'GET' &&
    url.pathname === '/auth/google/gmail/callback' &&
    options.gmailConsentFlow
  ) {
    const states = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    if (states.length !== 1 || codes.length !== 1)
      return send(res, 400, { error: 'invalid Gmail consent response' });
    try {
      await options.gmailConsentFlow.finish(
        session.subject,
        states[0]!,
        codes[0]!,
        req.headers.cookie,
      );
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': GmailConsentStateStore.clearCookie(),
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    } catch {
      res.setHeader('Set-Cookie', GmailConsentStateStore.clearCookie());
      return send(res, 403, { error: 'Gmail connection failed' });
    }
  }
  if (method !== 'GET') {
    if (
      req.headers.origin !== options.origin ||
      !matchesCsrf(req.headers['x-csrf-token'], session.csrfToken)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { error: 'application/json required' });
    }
  }
  const { store } = options;
  if (method === 'GET' && url.pathname === '/') return send(res, 200, BETA_PAGE, true);
  if (method === 'POST' && url.pathname === '/api/logout' && options.identityFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    res.setHeader('Set-Cookie', options.identityFlow.logout(req.headers.cookie));
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/session') {
    const request = store.ownRequest(session.subject);
    return send(res, 200, {
      email: session.verifiedEmail,
      csrfToken: session.csrfToken,
      isAdmin: store.isAdmin(session.subject),
      request: request && { ...request, active: store.isActive(session.subject, now) },
      gmailAvailable: !!options.gmailConsentFlow,
      gmailConnected: options.gmailConsentFlow?.isConnected(session.subject) ?? false,
      configAvailable: !!options.userConfigStore,
    });
  }
  if (method === 'POST' && url.pathname === '/api/access/request') {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    store.requestAccess(session.subject, session.verifiedEmail, options.now?.() ?? Date.now());
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/config' && options.userConfigStore) {
    return send(res, 200, options.userConfigStore.get(session.subject, now));
  }
  if (method === 'PUT' && url.pathname === '/api/config' && options.userConfigStore) {
    const input = ConfigSchema.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid configuration' });
    return send(
      res,
      200,
      options.userConfigStore.save(session.subject, input.data, options.now?.() ?? Date.now()),
    );
  }
  if (method === 'POST' && url.pathname === '/api/gmail/connect' && options.gmailConsentFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    const start = options.gmailConsentFlow.start(session.subject);
    res.setHeader('Set-Cookie', start.cookie);
    return send(res, 200, { location: start.location });
  }
  if (method === 'POST' && url.pathname === '/api/gmail/disconnect' && options.gmailConsentFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    await options.gmailConsentFlow.disconnect(session.subject);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && url.pathname === '/api/gmail/forget' && options.gmailConsentFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    options.gmailConsentFlow.forget(session.subject);
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/admin/requests') {
    const requests = store.listRequests(session.subject).map((r) => ({
      ...r,
      active: store.isActive(r.subject, now),
      attempts: store.readUsage(session.subject, r.subject, now).attempts,
    }));
    return send(res, 200, requests);
  }
  if (method === 'GET' && url.pathname === '/api/admin/metrics')
    return send(res, 200, store.metrics(session.subject, now));
  if (method === 'POST' && url.pathname === '/api/admin/approve') {
    const input = Approval.safeParse(await readAuthorizedJson(options, req, session));
    const decisionTime = options.now?.() ?? Date.now();
    if (!input.success || input.data.expiresAt <= decisionTime)
      return send(res, 400, { error: 'invalid approval' });
    store.approve(
      session.subject,
      input.data.subject,
      input.data.expiresAt,
      input.data.dailyLimit,
      decisionTime,
    );
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && url.pathname === '/api/admin/deny') {
    const input = Denial.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid request' });
    store.deny(session.subject, input.data.subject, options.now?.() ?? Date.now());
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

/** Unwired prototype. It is unsafe to expose until a real session adapter is implemented and tested. */
export function createBetaServer(options: BetaServerOptions): Server {
  const parsed = new URL(options.origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== options.origin)
    throw new Error('exact HTTPS origin required');
  return createServer((req, res) => {
    handle(options, req, res).catch((error: unknown) => {
      if (error instanceof AccessDeniedError) return send(res, 403, { error: 'forbidden' });
      if (error instanceof SessionExpiredError)
        return send(res, 401, { error: 'authentication required' });
      if (error instanceof RequestTooLargeError)
        return send(res, 413, { error: 'request too large' });
      if (error instanceof SyntaxError) return send(res, 400, { error: 'invalid request' });
      return send(res, 500, { error: 'request failed' });
    });
  });
}
