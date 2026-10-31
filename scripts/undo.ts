// Remove labels applied since a time: npm run undo -- 2026-10-28T00:00:00Z
// Only reverses the label (restores INBOX and UNREAD for archived or read mail too).
import { CONTENT_FILTERED_CATEGORY, loadConfigFile } from '../src/config.js';
import { GmailClient, oauthClientFromSecrets } from '../src/gmail.js';
import { labelName } from '../src/pipeline.js';
import { State } from '../src/state.js';

const since = process.argv[2];
if (!since || Number.isNaN(Date.parse(since))) {
  console.error('usage: npm run undo -- <ISO timestamp>');
  process.exit(1);
}
const config = loadConfigFile(process.env.CONFIG_PATH ?? 'config/categories.yaml');
const state = new State(`${process.env.DATA_DIR ?? 'data'}/state.db`);
const mail = GmailClient.fromAuth(oauthClientFromSecrets(process.env.SECRETS_DIR ?? 'secrets'));

const names = config.categories.map((cat) => labelName(config, cat.id));
names.push(labelName(config, CONTENT_FILTERED_CATEGORY));
const ids = await mail.ensureLabels(names, false);
const rows = state.appliedSince(new Date(since).toISOString());
for (const row of rows) {
  const labelId = ids.get(labelName(config, row.category));
  const cat = config.categories.find((x) => x.id === row.category);
  const add: string[] = [];
  if (cat?.actions.includes('archive')) add.push('INBOX');
  if (cat?.actions.includes('mark_read')) add.push('UNREAD');
  await mail.modify(row.message_id, {
    add,
    remove: [...(labelId ? [labelId] : []), ...(cat?.actions.includes('star') ? ['STARRED'] : [])],
  });
}
console.log(`undid ${rows.length} decisions`);
