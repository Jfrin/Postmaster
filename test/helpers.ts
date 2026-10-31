import { parseConfig, type Category, type Config } from '../src/config.js';
import type { Classifier, ModelResult } from '../src/classifier.js';
import { silentLogger } from '../src/logger.js';
import type { BaseContext } from '../src/pipeline.js';
import { State } from '../src/state.js';
import { parseAddress } from '../src/text.js';
import type { EmailMessage, MailClient, ModifyRequest } from '../src/types.js';

export const YAML = `
settings:
  dry_run: false
  daily_llm_call_cap: 5
rules:
  - match: { from_domain: "github.com" }
    category: dev
categories:
  - { id: receipts, label: Receipts, description: Orders, actions: [label, mark_read, archive] }
  - { id: dev, label: Dev, description: Dev mail, actions: [label, archive] }
  - { id: needs_review, label: Needs Review, description: Unsure, actions: [label] }
`;

export function makeConfig(patch: (c: Config) => void = () => {}): Config {
  const cfg = parseConfig(YAML);
  patch(cfg);
  return cfg;
}

export function makeMessage(over: Partial<EmailMessage> = {}): EmailMessage {
  const from = over.from ?? 'Shop <orders@shop.example>';
  return {
    id: 'm1',
    threadId: 't1',
    from,
    ...parseAddress(from),
    subject: 'Your order has shipped',
    date: 'Wed, 28 Oct 2026 10:00:00 +0000',
    hasListUnsubscribe: false,
    body: 'Your order is on its way.',
    labelIds: ['INBOX', 'UNREAD'],
    ...over,
  };
}

export class FakeMail implements MailClient {
  modifies: { id: string; change: ModifyRequest }[] = [];
  createdLabels: string[] = [];
  messages = new Map<string, EmailMessage>();
  existing = new Map<string, string>();

  add(msg: EmailMessage) {
    this.messages.set(msg.id, msg);
  }
  ensureLabels(names: string[], create: boolean) {
    const out = new Map<string, string>();
    for (const n of names) {
      if (!this.existing.has(n) && create) {
        this.existing.set(n, `L_${n}`);
        this.createdLabels.push(n);
      }
      const id = this.existing.get(n);
      if (id) out.set(n, id);
    }
    return Promise.resolve(out);
  }
  listNew() {
    return Promise.resolve({ ids: [...this.messages.keys()], cursor: '100' });
  }
  fetchMessage(id: string) {
    const m = this.messages.get(id);
    return m ? Promise.resolve(m) : Promise.reject(new Error(`no message ${id}`));
  }
  modify(id: string, change: ModifyRequest) {
    this.modifies.push({ id, change });
    return Promise.resolve();
  }
}

export class FakeClassifier implements Classifier {
  calls = 0;
  lastCategoryIds: string[] = [];
  constructor(private readonly result: ModelResult | Error) {}
  classify(_msg: EmailMessage, categories: Category[]) {
    this.calls++;
    this.lastCategoryIds = categories.map((c) => c.id);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

export function makeContext(opts: {
  config?: Config;
  mail?: FakeMail;
  classifier?: Classifier;
  state?: State;
}): BaseContext & { mail: FakeMail; state: State } {
  return {
    config: opts.config ?? makeConfig(),
    mail: opts.mail ?? new FakeMail(),
    classifier:
      opts.classifier ??
      new FakeClassifier({ category: 'receipts', confidence: 0.95, reason: 'test' }),
    state: opts.state ?? new State(':memory:'),
    log: silentLogger,
    now: () => new Date('2026-10-28T10:00:00Z'),
  } as BaseContext & { mail: FakeMail; state: State };
}
