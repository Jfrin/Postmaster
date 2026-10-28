import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Logger } from './logger.js';

const ID = /^[a-z][a-z0-9_]*$/;

const SettingsSchema = z
  .object({
    label_prefix: z.string().default('AI/'),
    confidence_threshold: z.number().min(0).max(1).default(0.7),
    fallback_category: z.string().default('needs_review'),
    dry_run: z.boolean().default(true),
    poll_interval_seconds: z.number().int().positive().default(300),
    max_body_chars: z.number().int().positive().default(1500),
    daily_llm_call_cap: z.number().int().nonnegative().default(2000),
    backlog_days: z.number().int().positive().default(7),
  })
  .strict();

const MatchSchema = z
  .object({
    from: z.string().min(1).optional(),
    from_domain: z.string().min(1).optional(),
    subject_contains: z.string().min(1).optional(),
  })
  .strict()
  .refine((m) => m.from || m.from_domain || m.subject_contains, {
    message: 'a rule match needs at least one of from, from_domain, subject_contains',
  });

const RuleSchema = z.object({ match: MatchSchema, category: z.string() }).strict();

// There is deliberately no delete or send action.
export const ActionSchema = z.enum(['label', 'star', 'mark_read', 'archive']);

const CategorySchema = z
  .object({
    id: z.string().regex(ID, 'ids are lowercase letters, digits and underscores'),
    label: z.string().min(1),
    description: z.string().min(1),
    examples: z.array(z.string()).default([]),
    actions: z.array(ActionSchema).default(['label']),
  })
  .strict();

export const ConfigSchema = z
  .object({
    settings: SettingsSchema.prefault({}),
    rules: z.array(RuleSchema).default([]),
    categories: z.array(CategorySchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = cfg.categories.map((c) => c.id);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate category id: ${id}` });
      seen.add(id);
    }
    if (!seen.has(cfg.settings.fallback_category)) {
      ctx.addIssue({
        code: 'custom',
        message: `fallback_category "${cfg.settings.fallback_category}" is not a defined category`,
      });
    }
    cfg.rules.forEach((r, i) => {
      if (!seen.has(r.category)) {
        ctx.addIssue({
          code: 'custom',
          message: `rules[${i}] points at unknown category "${r.category}"`,
        });
      }
    });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Category = Config['categories'][number];
export type Rule = Config['rules'][number];

export function parseConfig(yamlText: string): Config {
  return ConfigSchema.parse(parse(yamlText));
}

export function loadConfigFile(path: string): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}

/** Re-reads the file each cycle and keeps the last good config if the new one is invalid. */
export class ConfigStore {
  private current: Config;

  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {
    this.current = loadConfigFile(path); // the first load must succeed
  }

  get(): Config {
    return this.current;
  }

  reload(): Config {
    try {
      this.current = loadConfigFile(this.path);
    } catch (err) {
      this.log.error({ err: String(err) }, 'config invalid, keeping last good config');
    }
    return this.current;
  }
}
