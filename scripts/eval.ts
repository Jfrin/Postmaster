// npm run eval -- [--mock]. Reads eval/dataset.jsonl: {"from","subject","body","label"} per line.
import { readFileSync } from 'node:fs';
import { AzureClassifier, MockClassifier } from '../src/classifier.js';
import { loadConfigFile } from '../src/config.js';
import { evaluate } from '../src/eval.js';
import { parseAddress } from '../src/text.js';
import type { EmailMessage } from '../src/types.js';

const config = loadConfigFile(process.env.CONFIG_PATH ?? 'config/categories.yaml');
const classifier = process.argv.includes('--mock')
  ? new MockClassifier()
  : AzureClassifier.fromEnv();
const lines = readFileSync('eval/dataset.jsonl', 'utf8').split('\n').filter(Boolean);

const rows = [];
for (const line of lines) {
  const r = JSON.parse(line) as { from: string; subject: string; body: string; label: string };
  const msg: EmailMessage = {
    id: 'eval',
    threadId: 'eval',
    from: r.from,
    ...parseAddress(r.from),
    subject: r.subject,
    date: '',
    hasListUnsubscribe: false,
    body: r.body,
    labelIds: [],
  };
  const out = await classifier.classify(msg, config.categories);
  const predicted =
    out.confidence < config.settings.confidence_threshold
      ? config.settings.fallback_category
      : out.category;
  rows.push({ expected: r.label, predicted });
}
const report = evaluate(rows);
console.log(`accuracy ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.total})`);
console.table(report.confusion);
