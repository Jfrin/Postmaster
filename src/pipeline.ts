import { CONTENT_FILTERED_CATEGORY, CONTENT_FILTERED_LABEL, type Config } from './config.js';
import type { Classifier } from './classifier.js';
import { GmailQuotaError } from './gmail-quota.js';
import type { Logger } from './logger.js';
import { decide, localDecision } from './pipeline-decision.js';
import type { State } from './state.js';
import type { Action, EmailMessage, MailClient, ModifyRequest } from './types.js';

export { decide } from './pipeline-decision.js';

export interface CycleHooks {
  /** Stops scheduling messages; already in-flight cached writes finish before returning. */
  shouldStop?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface CycleStats {
  seen: number;
  processed: number;
  failed: number;
  stopped?: boolean;
}

export interface BaseContext {
  hooks?: CycleHooks;
  /** Scan the configured inbox window even when a history cursor already exists. */
  scanBacklog?: boolean;
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
  if (categoryId === CONTENT_FILTERED_CATEGORY) {
    return `${config.settings.label_prefix}${CONTENT_FILTERED_LABEL}`;
  }
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

export async function processMessage(ctx: PipelineContext, msg: EmailMessage): Promise<Outcome> {
  const { config, mail, state, log } = ctx;

  // Idempotent: never apply twice, and skip threads that already carry an AI/ label. In dry run
  // any earlier decision counts (no re-spend); when live, only an applied one does, so mail that
  // was only seen in dry run still gets filed.
  const own = new Set(ctx.labelIds.values());
  const already = state.hasDecision(msg.id, !config.settings.dry_run);
  if (already || msg.labelIds.some((l) => own.has(l))) return 'skipped';

  const decision = await decide(ctx, msg);
  const category = config.categories.find((c) => c.id === decision.category);
  const actions = category?.actions ?? ['label'];
  const dry = config.settings.dry_run;
  const labelId = ctx.labelIds.get(decision.category);
  if (!dry && decision.category === CONTENT_FILTERED_CATEGORY && !labelId) {
    throw new Error('content-filtered label is unavailable');
  }
  const change = buildModify(actions, labelId);

  log.info(
    { id: msg.id, ...decision, actions, dry_run: dry },
    dry ? 'decision (dry run, nothing changed)' : 'decision',
  );

  if (!dry) await mail.modify(msg.id, change);
  state.recordDecision(msg.id, decision, !dry, ctx.now(), {
    sender: msg.address,
    subject: msg.subject.slice(0, 200),
  });
  return dry ? 'dry_run' : 'applied';
}

export async function runCycle(base: BaseContext): Promise<CycleStats> {
  const { mail, state, config, log } = base;

  // Labels are created only when not in dry run, so a dry run changes nothing in Gmail.
  // Done every cycle so flipping dry_run to false needs no restart.
  const names = new Map(config.categories.map((c) => [labelName(config, c.id), c.id]));
  names.set(labelName(config, CONTENT_FILTERED_CATEGORY), CONTENT_FILTERED_CATEGORY);
  const found = await mail.ensureLabels([...names.keys()], !config.settings.dry_run);
  const labelIds = new Map<string, string>();
  for (const [name, id] of found) {
    const cat = names.get(name);
    if (cat) labelIds.set(cat, id);
  }
  const ctx: PipelineContext = { ...base, labelIds };

  const listed = await mail.listNew(
    base.scanBacklog ? null : state.getCursor(),
    config.settings.backlog_days,
  );
  const ids = [...new Set(listed.ids)];
  const cursor = listed.cursor;
  let processed = 0;
  let failed = 0;
  let stopped = false;
  let done = 0;
  let quotaError: GmailQuotaError | null = null;
  // Bound both read-ahead and cached writes. Gmail latency used to be paid twice per email,
  // serially, even when classification was an instant local lookup.
  const concurrency = 8;
  const progress = () => base.hooks?.onProgress?.(++done, ids.length);
  const process = async (msg: EmailMessage): Promise<void> => {
    try {
      if ((await processMessage(ctx, msg)) !== 'skipped') processed++;
    } catch (err) {
      if (err instanceof GmailQuotaError) quotaError = err;
      failed++;
      log.error({ err: String(err), id: msg.id }, 'message failed');
    }
    progress();
  };
  for (let offset = 0; offset < ids.length; offset += concurrency) {
    if (base.hooks?.shouldStop?.()) {
      stopped = true;
      break;
    }
    const batch = ids.slice(offset, offset + concurrency);
    const fetched = await Promise.allSettled(
      batch.map(async (id) => {
        // Live mode still files decisions that were only seen in dry run.
        if (state.hasDecision(id, !config.settings.dry_run)) return null;
        return mail.fetchMessage(id, config.settings.max_body_chars);
      }),
    );
    const pending: Promise<void>[] = [];
    for (const [index, result] of fetched.entries()) {
      if (quotaError) break;
      // The first email was started before fetching; finish it on Stop. The remaining
      // reads are speculative and must not start new writes once Stop is requested.
      if (index > 0 && base.hooks?.shouldStop?.()) {
        stopped = true;
        break;
      }
      if (result.status === 'rejected') {
        if (result.reason instanceof GmailQuotaError) quotaError = result.reason;
        failed++;
        log.error({ err: String(result.reason), id: batch[index] }, 'message failed');
        progress();
      } else if (!result.value) {
        progress();
      } else if (localDecision(ctx, result.value)?.source === 'cache') {
        pending.push(process(result.value));
      } else {
        // Keep model learning ordered: after three confident answers, later messages from
        // that sender can use the cache rather than making redundant concurrent model calls.
        await Promise.all(pending);
        pending.length = 0;
        if (quotaError) break;
        if (index > 0 && base.hooks?.shouldStop?.()) {
          stopped = true;
          break;
        }
        await process(result.value);
      }
    }
    await Promise.all(pending);
    // Drain writes, preserve the cursor, and let the poller wait out the shared cooldown.
    if (quotaError) throw quotaError;
    if (stopped) break;
  }
  // Hold the cursor back if anything failed or we were stopped; finished messages are skipped
  // next time, so nothing is done twice.
  if (failed === 0 && !stopped) state.setCursor(cursor);
  return { seen: ids.length, processed, failed, ...(stopped ? { stopped: true } : {}) };
}
