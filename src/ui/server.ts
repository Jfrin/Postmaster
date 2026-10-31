import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { Classifier } from '../classifier.js';
import { ConfigSchema, loadConfigFile } from '../config.js';
import { heartbeatAgeMs, readControl, readStatus, writeControl } from '../control.js';
import { matchRule } from '../rules.js';
import type { State } from '../state.js';
import { cleanBody, parseAddress } from '../text.js';
import type { EmailMessage } from '../types.js';
import { PAGE } from './page.js';

export interface UiDeps {
  configPath: string;
  /** shared volume with the poller: control.json, status.json, heartbeat */
  dataDir: string;
  state: State;
  classifier: Classifier;
  /** which classifier backs the "Try it" tab, shown in the UI */
  mode: 'azure' | 'mock';
}

// Only answer requests addressed to localhost (blocks DNS rebinding from other sites).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 1_000_000;
const OFFLINE_AFTER_MS = 90_000;

const ControlSchema = z.object({ action: z.enum(['start', 'stop']) });

function runStatus(deps: UiDeps) {
  const age = heartbeatAgeMs(deps.dataDir, new Date());
  return {
    running: readControl(deps.dataDir).running,
    online: age !== null && age < OFFLINE_AFTER_MS,
    status: readStatus(deps.dataDir),
  };
}

const TrySchema = z.object({
  from: z.string().max(500),
  subject: z.string().max(1000),
  body: z.string().max(20000),
});

function send(res: ServerResponse, status: number, body: unknown, html = false): void {
  res.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(html
      ? {
          'Content-Security-Policy':
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
        }
      : {}),
  });
  res.end(html ? String(body) : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

function originAllowed(origin: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * Server-sent events for the Activity tab. The UI server and the poller share the same
 * SQLite file, so this only has to read the decision log and push it to the browser.
 */
function streamActivity(deps: UiDeps, res: ServerResponse, limit: number): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  let config: ReturnType<typeof loadConfigFile> | null = null;
  try {
    config = loadConfigFile(deps.configPath);
  } catch {
    // Reported in the payload below until the file is fixed.
  }
  const tick = (): void => {
    if (closed || res.writableEnded) return;
    try {
      config = loadConfigFile(deps.configPath);
    } catch {
      // Keep using the last good config, if any.
    }
    const payload = {
      decisions: deps.state.recent(limit),
      llmCallsToday: deps.state.llmCallsToday(new Date()),
      dailyCap: config?.settings.daily_llm_call_cap ?? 0,
      dryRun: config?.settings.dry_run ?? true,
      mode: deps.mode,
      run: runStatus(deps),
      ...(config ? {} : { error: 'config file is invalid' }),
    };
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      closed = true;
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  res.on('close', () => {
    closed = true;
    clearInterval(timer);
  });
  res.on('error', () => {
    closed = true;
    clearInterval(timer);
  });
}

async function handle(deps: UiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden host' });
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) return send(res, 403, { error: 'forbidden origin' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'content-type must be application/json' });
    }
  }

  if (method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, true);

  if (method === 'GET' && url.pathname === '/api/config') {
    try {
      return send(res, 200, loadConfigFile(deps.configPath));
    } catch (err) {
      return send(res, 500, { error: `config file is invalid: ${String(err)}` });
    }
  }

  if (method === 'PUT' && url.pathname === '/api/config') {
    const parsed = ConfigSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.map(String).join('.')}: ${i.message}`,
      );
      return send(res, 400, { error: issues.join('\n') });
    }
    const text =
      '# Edited via the Postmaster UI. The previous version is categories.yaml.bak\n' +
      stringify(parsed.data, { lineWidth: 0 });
    if (existsSync(deps.configPath)) copyFileSync(deps.configPath, `${deps.configPath}.bak`);
    const tmp = `${deps.configPath}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, deps.configPath);
    return send(res, 200, loadConfigFile(deps.configPath));
  }

  if (method === 'GET' && url.pathname === '/api/decisions') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const config = loadConfigFile(deps.configPath);
    return send(res, 200, {
      decisions: deps.state.recent(limit),
      llmCallsToday: deps.state.llmCallsToday(new Date()),
      dailyCap: config.settings.daily_llm_call_cap,
      dryRun: config.settings.dry_run,
      mode: deps.mode,
    });
  }

  if (method === 'GET' && url.pathname === '/api/activity/stream') {
    streamActivity(deps, res, 200);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/try') {
    const input = TrySchema.safeParse(await readJson(req));
    if (!input.success)
      return send(res, 400, { error: 'from, subject and body are required text' });
    const config = loadConfigFile(deps.configPath);
    const msg: EmailMessage = {
      id: 'try',
      threadId: 'try',
      from: input.data.from,
      ...parseAddress(input.data.from),
      subject: input.data.subject,
      date: new Date().toUTCString(),
      hasListUnsubscribe: false,
      body: cleanBody(input.data.body, false, config.settings.max_body_chars),
      labelIds: [],
    };
    let result: { category: string; confidence: number; source: string; reason: string };
    const rule = matchRule(config.rules, msg);
    if (rule) {
      result = { category: rule.category, confidence: 1, source: 'rule', reason: 'matched a rule' };
    } else {
      try {
        const out = await deps.classifier.classify(msg, config.categories);
        const low = out.confidence < config.settings.confidence_threshold;
        result = {
          ...out,
          category: low ? config.settings.fallback_category : out.category,
          source: low ? 'fallback (below confidence threshold)' : 'model',
        };
      } catch (err) {
        return send(res, 502, { error: `classifier failed: ${String(err)}` });
      }
    }
    const cat = config.categories.find((c) => c.id === result.category);
    return send(res, 200, {
      ...result,
      label: `${config.settings.label_prefix}${cat?.label ?? result.category}`,
      actions: cat?.actions ?? ['label'],
      mode: deps.mode,
    });
  }

  if (method === 'GET' && url.pathname === '/api/status') return send(res, 200, runStatus(deps));

  if (method === 'POST' && url.pathname === '/api/control') {
    const body = ControlSchema.safeParse(await readJson(req));
    if (!body.success) return send(res, 400, { error: 'action must be "start" or "stop"' });
    if (body.data.action === 'start') {
      try {
        loadConfigFile(deps.configPath);
      } catch (err) {
        return send(res, 400, { error: `config is invalid, fix it first: ${String(err)}` });
      }
      if (!runStatus(deps).online) {
        return send(res, 409, {
          error:
            'The Postmaster container is not running. Start it with: docker compose up -d postmaster',
        });
      }
      writeControl(deps.dataDir, true);
    } else {
      writeControl(deps.dataDir, false);
    }
    return send(res, 200, runStatus(deps));
  }

  return send(res, 404, { error: 'not found' });
}

export function createUiServer(deps: UiDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((err: unknown) => send(res, 500, { error: String(err) }));
  });
}
