import { join } from 'node:path';
import { z } from 'zod';
import { AzureClassifier, MockClassifier, type Classifier } from './classifier.js';
import { createLogger } from './logger.js';
import { State } from './state.js';
import { createUiServer } from './ui/server.js';

const Env = z.object({
  CONFIG_PATH: z.string().default('config/categories.yaml'),
  DATA_DIR: z.string().default('data'),
  POSTMASTER_MOCK: z.enum(['0', '1']).default('0'),
  PORT: z.coerce.number().default(8080),
});

const env = Env.parse(process.env);
const log = createLogger();

let classifier: Classifier = new MockClassifier();
let mode: 'azure' | 'mock' = 'mock';
if (env.POSTMASTER_MOCK === '0') {
  try {
    classifier = AzureClassifier.fromEnv();
    mode = 'azure';
  } catch (err) {
    log.warn(
      { err: String(err) },
      'no Azure settings found, "Try it" will use the mock classifier',
    );
  }
}

const state = new State(join(env.DATA_DIR, 'state.db'));
createUiServer({ configPath: env.CONFIG_PATH, state, classifier, mode }).listen(
  env.PORT,
  '0.0.0.0',
  () =>
    log.info({ port: env.PORT, mode }, 'Postmaster UI listening (publish it on 127.0.0.1 only)'),
);
