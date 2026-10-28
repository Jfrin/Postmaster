import type { Config } from './config.js';
import type { Classifier } from './classifier.js';
import type { Logger } from './logger.js';
import { matchRule } from './rules.js';
import type { State } from './state.js';
import type { Action, Decision, EmailMessage, MailClient, ModifyRequest } from './types.js';

export interface BaseContext {
  config: Config;
  mail: MailClient;
  classifier: Classifier;
  state: State;
  log: Logger;
  now: () => Date;
}

export interface PipelineContext extends BaseContext {
  /** category id -> Gmail label id (only labels that exist) */
  labelIds: Map<string, string>;
}

export type Outcome = 'skipped' | 'dry_run' | 'applied';

export function labelName(config: Config, categoryId: string): string {
  const cat = config.categories.find((c) => c.id === categoryId);
  return `${config.settings.label_prefix}${cat?.label ?? categoryId}`;
}

/** Translate configured actions into one Gmail modify call. No delete and no send exist here. */
export function buildModify(actions: Action[], labelId: string | undefined): ModifyRequest {
  const change: ModifyRequest = { add: [], remove: [] };
  for (const action of actions) {
    if (action === 'label' && labelId) change.add.push(labelId);
    if (action === 'star') change.add.push('STARRED');
    if (action === 'mark_read') change.remove.push('UNREAD');
    if (action === 'archive') change.remove.push('INBOX');
  }
  return change;
}

export async function decide(ctx: PipelineContext, msg: EmailMessage): Promise<Decision> {
  const { config, state, classifier, log } = ctx;
  const { settings } = config;

  const rule = matchRule(config.rules, msg);
  if (rule) {
    return { category: rule.category, confidence: 1, source: 'rule', reason: 'matched rule' };
  }

  const cached = state.cachedCategory(msg.address);
  if (cached && config.categories.some((c) => c.id === cached)) {
    return { category: cached, confidence: 1, source: 'cache', reason: 'sender cache' };
  }

  const now = ctx.now();
  if (state.llmCallsToday(now) >= settings.daily_llm_call_cap) {
    log.warn({ cap: settings.daily_llm_call_cap }, 'daily LLM call cap reached');
    return {
      category: settings.fallback_category,
      confidence: 0,
      source: 'fallback',
      reason: 'daily call cap reached',
    };
  }

  state.countLlmCall(now);
  try {
    const result = await classifier.classify(msg, config.categories);
    state.observeSender(msg.address, result.category, result.confidence);
    if (result.confidence < settings.confidence_threshold) {
      return { ...result, category: settings.fallback_category, source: 'fallback' };
    }
    return { ...result, source: 'model' };
  } catch (err) {
    log.error({ err: String(err), id: msg.id }, 'classification failed, using fallback');
    return {
      category: settings.fallback_category,
      confidence: 0,
      source: 'fallback',
      reason: 'classifier error',
    };
  }
}

export async function processMessage(ctx: PipelineContext, msg: EmailMessage): Promise<Outcome> {
  const { config, mail, state, log } = ctx;

  // Idempotent: never touch a message twice, and skip threads that already carry an AI/ label.
  const own = new Set(ctx.labelIds.values());
  if (state.hasDecision(msg.id) || msg.labelIds.some((l) => own.has(l))) return 'skipped';

  const decision = await decide(ctx, msg);
  const category = config.categories.find((c) => c.id === decision.category);
  const actions = category?.actions ?? ['label'];
  const change = buildModify(actions, ctx.labelIds.get(decision.category));
  const dry = config.settings.dry_run;

  log.info(
    { id: msg.id, ...decision, actions, dry_run: dry },
    dry ? 'decision (dry run, nothing changed)' : 'decision',
  );

  if (!dry) await mail.modify(msg.id, change);
  state.recordDecision(msg.id, decision, !dry, ctx.now());
  return dry ? 'dry_run' : 'applied';
}

export async function runCycle(
  base: BaseContext,
): Promise<{ seen: number; processed: number; failed: number }> {
  const { mail, state, config, log } = base;

  // Labels are created only when not in dry run, so a dry run changes nothing in Gmail.
  // Done every cycle so flipping dry_run to false needs no restart.
  const names = new Map(config.categories.map((c) => [labelName(config, c.id), c.id]));
  const found = await mail.ensureLabels([...names.keys()], !config.settings.dry_run);
  const labelIds = new Map<string, string>();
  for (const [name, id] of found) {
    const cat = names.get(name);
    if (cat) labelIds.set(cat, id);
  }
  const ctx: PipelineContext = { ...base, labelIds };

  const { ids, cursor } = await mail.listNew(state.getCursor(), config.settings.backlog_days);
  let processed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const msg = await mail.fetchMessage(id, config.settings.max_body_chars);
      if ((await processMessage(ctx, msg)) !== 'skipped') processed++;
    } catch (err) {
      failed++; // one bad message never stops the rest
      log.error({ err: String(err), id }, 'message failed');
    }
  }
  if (failed === 0) state.setCursor(cursor); // retry next cycle if anything failed
  return { seen: ids.length, processed, failed };
}
