import { join } from 'node:path';
import { z } from 'zod';
import { AzureClassifier, MockClassifier } from './classifier.js';
import { ConfigStore, loadConfigFile } from './config.js';
import { GmailClient, oauthClientFromSecrets } from './gmail.js';
import { createLogger } from './logger.js';
import { runPoller } from './poller.js';
import { State } from './state.js';

const Env = z.object({
  CONFIG_PATH: z.string().default('config/categories.yaml'),
  SECRETS_DIR: z.string().default('secrets'),
  DATA_DIR: z.string().default('data'),
  POSTMASTER_MOCK: z.enum(['0', '1']).default('0'),
});

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const log = createLogger();

  if (process.argv.includes('--check-config')) {
    const cfg = loadConfigFile(env.CONFIG_PATH); // throws with a readable zod error if invalid
    log.info({ categories: cfg.categories.length, rules: cfg.rules.length }, 'config ok');
    return;
  }

  const store = new ConfigStore(env.CONFIG_PATH, log);
  const state = new State(join(env.DATA_DIR, 'state.db')); // also creates the data directory

  let exiting = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (exiting = true));

  await runPoller({
    dataDir: env.DATA_DIR,
    reloadConfig: () => store.reload(), // re-read every cycle, no restart needed
    state,
    makeMail: () => GmailClient.fromAuth(oauthClientFromSecrets(env.SECRETS_DIR)),
    makeClassifier: () =>
      env.POSTMASTER_MOCK === '1' ? new MockClassifier() : AzureClassifier.fromEnv(),
    log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exiting: () => exiting,
  });
  state.close();
  log.info('shut down cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
