import { ContentFilteredError, InvalidModelOutputError } from './classifier.js';
import { CONTENT_FILTERED_CATEGORY, type Config } from './config.js';
import type { PipelineContext } from './pipeline.js';
import { matchRule } from './rules.js';
import type { Decision, EmailMessage } from './types.js';

function allowedCategories(config: Config, msg: EmailMessage) {
  // Unread-only categories cannot be selected by a rule, cache hit, or model for read mail.
  const unread = msg.labelIds.includes('UNREAD');
  return config.categories.filter((category) => unread || !category.only_if_unread);
}

export function localDecision(
  ctx: PipelineContext,
  msg: EmailMessage,
  allowed = allowedCategories(ctx.config, msg),
): Decision | null {
  const allowedIds = new Set(allowed.map((category) => category.id));
  const rule = matchRule(
    ctx.config.rules.filter((candidate) => allowedIds.has(candidate.category)),
    msg,
  );
  if (rule) {
    return { category: rule.category, confidence: 1, source: 'rule', reason: 'matched rule' };
  }

  const cached = ctx.state.cachedCategory(msg.address);
  if (cached && allowedIds.has(cached)) {
    return { category: cached, confidence: 1, source: 'cache', reason: 'sender cache' };
  }
  return null;
}

/** Choose a category without changing Gmail or recording a decision. */
export async function decide(ctx: PipelineContext, msg: EmailMessage): Promise<Decision> {
  const { config, state, classifier, log } = ctx;
  const { settings } = config;
  const allowed = allowedCategories(config, msg);
  const local = localDecision(ctx, msg, allowed);
  if (local) return local;

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
    const result = await classifier.classify(msg, allowed);
    state.observeSender(msg.address, result.category, result.confidence);
    if (result.confidence < settings.confidence_threshold) {
      return { ...result, category: settings.fallback_category, source: 'fallback' };
    }
    return { ...result, source: 'model' };
  } catch (err) {
    if (err instanceof ContentFilteredError) {
      log.warn({ id: msg.id }, 'Azure content filter, filing separately');
      return {
        category: CONTENT_FILTERED_CATEGORY,
        confidence: 0,
        source: 'fallback',
        reason: 'Azure content filtered',
      };
    }
    if (err instanceof InvalidModelOutputError) {
      log.warn({ err: String(err), id: msg.id }, 'invalid model output, using fallback');
      return {
        category: settings.fallback_category,
        confidence: 0,
        source: 'fallback',
        reason: 'invalid model output',
      };
    }
    // Infrastructure failures are retryable; do not record a decision for them.
    throw err;
  }
}
