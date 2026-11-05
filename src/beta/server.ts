import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ConfigSchema } from '../config.js';
import {
  AccessDeniedError,
  LiveConfirmationRequiredError,
  type BetaAccessStore,
} from './access.js';
import type { BetaActivityStore } from './activity.js';
import type { BetaDataPrivacy } from './data-privacy.js';
import { BetaSessionStore } from './session-store.js';
import type { GmailConsentFlow } from './gmail-consent-flow.js';
import { GmailConsentStateStore } from './gmail-consent-state.js';
import {
  IdentityAccessDeniedError,
  IdentityStateError,
  type IdentityFlow,
} from './identity-flow.js';
import { IdentityLoginStateStore } from './oauth-state.js';
import { BETA_PAGE } from './page.js';
import { BETA_ADMIN_PAGE } from './admin-page.js';
import { BETA_INTAKE_PAGE } from './intake-page.js';
import { PRIVACY_PAGE } from './privacy-page.js';
import { TERMS_PAGE } from './terms-page.js';
import {
  adminAccessPage,
  gmailConsentErrorPage,
  LANDING_PAGE,
  signInPage,
} from './welcome-page.js';
import type { BetaProcessingEvents } from './processing-events.js';
import { ConfigLiveConfirmationError, type BetaUserConfigStore } from './user-config.js';

/** A trusted server-side session adapter must supply these from a verified Google identity. */
export interface BetaSession {
  subject: string;
  verifiedEmail: string;
  csrfToken: string;
}

export interface BetaServerOptions {
  store: BetaAccessStore;
  origin: string;
  /** Optional single-segment mount path; OAuth callbacks remain at their registered root paths. */
  basePath?: string;
  /** Must validate an opaque, expiring session cookie; never trust client identity headers. */
  authenticate: (req: IncomingMessage) => Promise<BetaSession | null>;
  /** Pin administrative access to one verified identity when deployed. */
  adminIdentity?: { subject: string; email: string };
  /** Optional until Google identity is configured. Gmail consent remains separate. */
  identityFlow?: IdentityFlow;
  /** Only enable after Gmail policy, key management and isolation checks are complete. */
  gmailConsentFlow?: GmailConsentFlow;
  userConfigStore?: BetaUserConfigStore;
  activityStore?: BetaActivityStore;
  processingEvents?: BetaProcessingEvents;
  dataPrivacy?: BetaDataPrivacy;
  /** Must reflect the trusted scheduler's actual online status. */
  processingOnline?: () => boolean;
  notificationsEnabled?: boolean;
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
const ApplicationEmail = z
  .string()
  .trim()
  .email()
  .max(254)
  .regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/);
const Application = z.object({ email: ApplicationEmail }).strict();
const ApplicationDecision = z
  .object({
    email: z.string().email().max(254),
    status: z.enum(['approved', 'denied']),
    expiresAt: z.number().int().nonnegative().nullable(),
    dailyLimit: z.number().int().min(0).max(100_000),
  })
  .strict();
const Start = z.object({ confirmLive: z.boolean().optional() }).strict();
const DeleteData = z
  .object({ scope: z.enum(['content', 'decisions', 'other', 'all']), confirm: z.literal(true) })
  .strict();
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

async function readJson(req: IncomingMessage, maxBytes = 131_072): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += (chunk as Buffer).length;
    if (length > maxBytes) throw new RequestTooLargeError('request too large');
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
  const basePath = options.basePath ?? '';
  let path = url.pathname;
  if (method === 'GET' && path === '/privacy') return send(res, 200, PRIVACY_PAGE, true);
  if (method === 'GET' && path === '/terms') return send(res, 200, TERMS_PAGE, true);
  if (basePath && method === 'GET' && path === '/') return send(res, 200, LANDING_PAGE, true);
  if (basePath) {
    if (path === basePath) path = '/';
    else if (path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
    else if (path !== '/auth/google/callback' && path !== '/auth/google/gmail/callback')
      return send(res, 404, { error: 'not found' });
  }
  const now = options.now?.() ?? Date.now();
  if (method === 'GET' && path === '/apply')
    return send(
      res,
      200,
      BETA_INTAKE_PAGE.replace('__BETA_BASE_PATH__', JSON.stringify(basePath)).replace(
        '__NOTIFICATION_TEXT__',
        options.notificationsEnabled
          ? 'Decision emails are sent after review when delivery is available.'
          : 'Decisions are not emailed automatically.',
      ),
      true,
    );
  if (method === 'POST' && path === '/api/apply') {
    if (req.headers.origin !== options.origin) return send(res, 403, { error: 'forbidden' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
      return send(res, 415, { error: 'application/json required' });
    const input = Application.safeParse(await readJson(req, 2048));
    if (!input.success) return send(res, 400, { error: 'invalid application' });
    if (
      !options.store.submitApplication(
        input.data.email,
        options.now?.() ?? Date.now(),
        !!options.notificationsEnabled,
      )
    )
      return send(res, 429, { error: 'try again later' });
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/auth/google/start' && options.identityFlow) {
    const start = options.identityFlow.start(now);
    res.writeHead(302, {
      Location: start.location,
      'Set-Cookie': start.cookie,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }
  if (method === 'GET' && path === '/auth/google/callback' && options.identityFlow) {
    const states = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    if (states.length !== 1 || codes.length !== 1) {
      res.setHeader('Set-Cookie', IdentityLoginStateStore.clearCookie());
      return send(
        res,
        400,
        signInPage(
          basePath,
          'Sign-in was cancelled or the response was invalid. Please try again.',
        ),
        true,
      );
    }
    try {
      const cookie = await options.identityFlow.finish(
        states[0]!,
        codes[0]!,
        req.headers.cookie,
        now,
      );
      res.writeHead(302, {
        Location: `${basePath}/`,
        'Set-Cookie': [IdentityLoginStateStore.clearCookie(), cookie],
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    } catch (error) {
      res.setHeader('Set-Cookie', IdentityLoginStateStore.clearCookie());
      const message =
        error instanceof IdentityStateError
          ? 'Your sign-in attempt expired or the browser cookie was missing. Start again in the same browser.'
          : error instanceof IdentityAccessDeniedError
            ? 'This Google account is not approved for beta access. Check the account and application approval.'
            : 'Sign-in could not be completed. Try again; if it persists, contact the beta administrator.';
      return send(res, 401, signInPage(basePath, message), true);
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
    if (method === 'GET' && path === '/auth/google/gmail/callback' && options.gmailConsentFlow) {
      res.setHeader('Set-Cookie', GmailConsentStateStore.clearCookie());
      return send(
        res,
        401,
        gmailConsentErrorPage(
          basePath,
          'Your beta session is missing or expired. Sign in again before connecting Gmail.',
        ),
        true,
      );
    }
    if (method === 'GET' && path === '/admin')
      return send(res, 401, adminAccessPage(basePath, false), true);
    if (method === 'GET' && path === '/' && options.identityFlow) {
      return send(res, 200, signInPage(basePath), true);
    }
    return send(res, 401, { error: 'authentication required' });
  }
  if (method === 'GET' && path === '/auth/google/gmail/callback' && options.gmailConsentFlow) {
    const states = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    if (states.length !== 1 || codes.length !== 1) {
      res.setHeader('Set-Cookie', GmailConsentStateStore.clearCookie());
      return send(
        res,
        400,
        gmailConsentErrorPage(basePath, 'The Google consent response was cancelled or invalid.'),
        true,
      );
    }
    try {
      await options.gmailConsentFlow.finish(
        session.subject,
        states[0]!,
        codes[0]!,
        req.headers.cookie,
      );
      res.writeHead(302, {
        Location: `${basePath}/`,
        'Set-Cookie': GmailConsentStateStore.clearCookie(),
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    } catch {
      res.setHeader('Set-Cookie', GmailConsentStateStore.clearCookie());
      return send(
        res,
        403,
        gmailConsentErrorPage(
          basePath,
          'We could not complete this Gmail connection. The request may have expired or used a different Google account.',
        ),
        true,
      );
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
  const isAdmin =
    store.isAdmin(session.subject) &&
    (!options.adminIdentity ||
      (session.subject === options.adminIdentity.subject &&
        session.verifiedEmail.toLowerCase() === options.adminIdentity.email.toLowerCase()));
  if (method === 'GET' && path === '/')
    return send(res, 200, BETA_PAGE.replace('__BETA_BASE_PATH__', JSON.stringify(basePath)), true);
  if (method === 'GET' && path === '/admin') {
    if (!isAdmin) return send(res, 403, adminAccessPage(basePath, true), true);
    return send(
      res,
      200,
      BETA_ADMIN_PAGE.replace('__BETA_BASE_PATH__', JSON.stringify(basePath)).replace(
        '__NOTIFICATION_TEXT__',
        options.notificationsEnabled
          ? 'Decision emails are queued; delivery can fail. Check notification status below.'
          : 'Decisions are not emailed automatically.',
      ),
      true,
    );
  }
  if (path.startsWith('/api/admin/') && !isAdmin) return send(res, 403, { error: 'forbidden' });
  if (method === 'POST' && path === '/api/logout' && options.identityFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    res.setHeader('Set-Cookie', options.identityFlow.logout(req.headers.cookie));
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/api/session') {
    const request = store.ownRequest(session.subject);
    return send(res, 200, {
      email: session.verifiedEmail,
      csrfToken: session.csrfToken,
      isAdmin,
      request: request && {
        ...request,
        active: store.isActive(session.subject, now),
      },
      gmailAvailable: !!options.gmailConsentFlow,
      gmailConnected: options.gmailConsentFlow?.isConnected(session.subject) ?? false,
      gmailReady: options.gmailConsentFlow?.isReady(session.subject) ?? false,
      configAvailable: !!options.userConfigStore,
      activityAvailable: !!options.activityStore,
      dataDeletionAvailable: !!options.dataPrivacy,
      processingOnline: options.processingOnline?.() ?? false,
      processingRequested: store.processingRequested(session.subject),
      usage: store.ownUsage(session.subject, now),
    });
  }
  if (method === 'POST' && path === '/api/data/delete' && options.dataPrivacy) {
    const input = DeleteData.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid deletion request' });
    options.dataPrivacy.delete(
      session.subject,
      session.verifiedEmail,
      input.data.scope,
      options.now?.() ?? Date.now(),
    );
    return send(res, 200, { ok: true });
  }
  if (
    method === 'POST' &&
    path === '/api/account/delete' &&
    options.dataPrivacy &&
    options.gmailConsentFlow
  ) {
    const input = z
      .object({ confirm: z.literal(true) })
      .strict()
      .safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid deletion request' });
    let revoked: boolean;
    try {
      revoked = await options.gmailConsentFlow.disconnect(session.subject);
    } catch {
      return send(res, 503, {
        error: 'Gmail revocation failed or is in progress; account was not deleted',
      });
    }
    const current = await options.authenticate(req);
    if (!current || current.subject !== session.subject || current.csrfToken !== session.csrfToken)
      return send(res, 401, { error: 'session expired; account was not deleted' });
    try {
      options.dataPrivacy.delete(
        session.subject,
        session.verifiedEmail,
        'account',
        options.now?.() ?? Date.now(),
      );
    } catch {
      return send(res, 409, { error: 'Account was not deleted; check Gmail connection and retry' });
    }
    res.setHeader('Set-Cookie', BetaSessionStore.clearCookie());
    return send(res, 200, { ok: true, gmailRevocation: revoked ? 'requested' : 'no-local-token' });
  }
  if (method === 'POST' && path === '/api/access/request') {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    store.requestAccess(session.subject, session.verifiedEmail, options.now?.() ?? Date.now());
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/api/config' && options.userConfigStore) {
    return send(res, 200, options.userConfigStore.get(session.subject, now));
  }
  if (method === 'PUT' && path === '/api/config' && options.userConfigStore) {
    const input = ConfigSchema.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success)
      return send(res, 400, {
        error: `Invalid configuration: ${input.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
          .join('; ')}`,
      });
    return send(
      res,
      200,
      options.userConfigStore.save(
        session.subject,
        input.data,
        options.now?.() ?? Date.now(),
        req.headers['x-confirm-live'] === 'yes',
      ),
    );
  }
  if (method === 'GET' && path === '/api/activity' && options.activityStore) {
    return send(res, 200, options.activityStore.recent(session.subject, now));
  }
  if (method === 'GET' && path === '/api/processing/events' && options.processingEvents) {
    return send(res, 200, options.processingEvents.recent(session.subject, now));
  }
  if (method === 'POST' && path === '/api/processing/start' && options.processingOnline) {
    const input = Start.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid request' });
    if (!options.processingOnline() || !options.userConfigStore)
      return send(res, 503, { error: 'processing unavailable' });
    const time = options.now?.() ?? Date.now();
    options.userConfigStore.get(session.subject, time);
    store.startProcessingWithConfirmation(
      session.subject,
      options.now?.() ?? Date.now(),
      input.data.confirmLive === true,
    );
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/processing/stop' && options.processingOnline) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    store.stopProcessing(session.subject);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/gmail/connect' && options.gmailConsentFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    if (!store.ownRequest(session.subject))
      store.requestAccess(session.subject, session.verifiedEmail, options.now?.() ?? Date.now());
    const start = options.gmailConsentFlow.start(session.subject);
    res.setHeader('Set-Cookie', start.cookie);
    return send(res, 200, { location: start.location });
  }
  if (method === 'POST' && path === '/api/gmail/disconnect' && options.gmailConsentFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    await options.gmailConsentFlow.disconnect(session.subject);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/gmail/forget' && options.gmailConsentFlow) {
    if (!Request.safeParse(await readAuthorizedJson(options, req, session)).success)
      return send(res, 400, { error: 'invalid request' });
    options.gmailConsentFlow.forget(session.subject);
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/api/admin/requests') {
    const requests = store.listRequests(session.subject).map((r) => ({
      ...r,
      active: store.isActive(r.subject, now),
      attempts: store.readUsage(session.subject, r.subject, now).attempts,
      cycleUsage: store.cycleUsage(session.subject, r.subject, now),
    }));
    return send(res, 200, requests);
  }
  if (method === 'GET' && path === '/api/admin/applications')
    return send(res, 200, store.listApplications(session.subject));
  if (method === 'POST' && path === '/api/admin/delete-application') {
    const input = Application.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid application' });
    if (!store.deleteApplication(session.subject, input.data.email, now))
      return send(res, 404, { error: 'application not found' });
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/api/admin/notifications')
    return send(res, 200, {
      enabled: !!options.notificationsEnabled,
      ...store.notificationCounts(session.subject, false),
      failures: store.failedNotifications(session.subject, false),
    });
  if (method === 'POST' && path === '/api/admin/notifications/retry') {
    const input = z
      .object({
        id: z
          .number()
          .int()
          .safe()
          .refine((id) => id > 0),
      })
      .strict()
      .safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid notification' });
    if (!options.notificationsEnabled)
      return send(res, 503, { error: 'notifications unavailable' });
    if (!store.retryNotification(session.subject, input.data.id, options.now?.() ?? Date.now()))
      return send(res, 404, { error: 'notification not found' });
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/admin/application-decision') {
    const input = ApplicationDecision.safeParse(await readAuthorizedJson(options, req, session));
    if (
      !input.success ||
      (input.data.status === 'approved' &&
        (input.data.expiresAt === null || input.data.expiresAt <= now))
    )
      return send(res, 400, { error: 'invalid decision' });
    store.decideApplication(
      session.subject,
      input.data.email,
      input.data.status,
      input.data.expiresAt,
      input.data.dailyLimit,
      now,
      options.notificationsEnabled,
    );
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/api/admin/metrics')
    return send(res, 200, store.metrics(session.subject, now));
  if (method === 'POST' && path === '/api/admin/approve') {
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
  if (method === 'POST' && path === '/api/admin/deny') {
    const input = Denial.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid request' });
    store.deny(session.subject, input.data.subject, options.now?.() ?? Date.now());
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/admin/delete-access') {
    const input = Denial.safeParse(await readAuthorizedJson(options, req, session));
    if (!input.success) return send(res, 400, { error: 'invalid request' });
    if (!store.deleteAccess(session.subject, input.data.subject, options.now?.() ?? Date.now()))
      return send(res, 404, { error: 'request not found' });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

/** Unwired prototype. It is unsafe to expose until a real session adapter is implemented and tested. */
export function createBetaServer(options: BetaServerOptions): Server {
  const parsed = new URL(options.origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== options.origin)
    throw new Error('exact HTTPS origin required');
  if (options.basePath && !/^\/[A-Za-z0-9_-]+$/.test(options.basePath))
    throw new Error('invalid beta mount path');
  return createServer((req, res) => {
    handle(options, req, res).catch((error: unknown) => {
      if (error instanceof AccessDeniedError) return send(res, 403, { error: 'forbidden' });
      if (
        error instanceof LiveConfirmationRequiredError ||
        error instanceof ConfigLiveConfirmationError
      )
        return send(res, 409, { error: 'live-mode confirmation required' });
      if (error instanceof SessionExpiredError)
        return send(res, 401, { error: 'authentication required' });
      if (error instanceof RequestTooLargeError)
        return send(res, 413, { error: 'request too large' });
      if (error instanceof SyntaxError) return send(res, 400, { error: 'invalid request' });
      return send(res, 500, { error: 'request failed' });
    });
  });
}
