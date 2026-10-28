import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AzureClassifier, MockClassifier, type Classifier } from './classifier.js';
import { ConfigStore, loadConfigFile } from './config.js';
import { GmailClient, oauthClientFromSecrets } from './gmail.js';
import { createLogger } from './logger.js';
import { runCycle } from './pipeline.js';
import { State } from './state.js';

const Env = z.object({
  CONFIG_PATH: z.string().default('config/categories.yaml'),
  SECRETS_DIR: z.string().default('secrets'),
  DATA_DIR: z.string().default('data'),
  POSTMASTER_MOCK: z.enum(['0', '1']).default('0'),
});

function touch(path: string): void {
  if (existsSync(path)) utimesSync(path, new Date(), new Date());
  else writeFileSync(path, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const log = createLogger();

  if (process.argv.includes('--check-config')) {
    const cfg = loadConfigFile(env.CONFIG_PATH); // throws with a readable zod error if invalid
    log.info({ categories: cfg.categories.length, rules: cfg.rules.length }, 'config ok');
    return;
  }

  mkdirSync(env.DATA_DIR, { recursive: true });
  const store = new ConfigStore(env.CONFIG_PATH, log);
  const state = new State(join(env.DATA_DIR, 'state.db'));
  const mail = GmailClient.fromAuth(oauthClientFromSecrets(env.SECRETS_DIR));
  const classifier: Classifier =
    env.POSTMASTER_MOCK === '1' ? new MockClassifier() : AzureClassifier.fromEnv();
  const heartbeat = join(env.DATA_DIR, 'heartbeat');

  let running = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (running = false));

  while (running) {
    const config = store.reload(); // re-read every cycle, no restart needed
    try {
      const stats = await runCycle({ config, mail, classifier, state, log, now: () => new Date() });
      log.info({ ...stats, dry_run: config.settings.dry_run }, 'cycle complete');
    } catch (err) {
      log.error({ err: String(err) }, 'cycle failed');
    }
    touch(heartbeat);
    // sleep in short slices so SIGTERM stops the container promptly
    for (let i = 0; i < config.settings.poll_interval_seconds && running; i++) await sleep(1000);
  }
  state.close();
  log.info('shut down cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
