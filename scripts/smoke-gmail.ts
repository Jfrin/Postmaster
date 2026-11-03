// Verify authorization with getProfile only; do not list or modify mail.
import { gmail } from '@googleapis/gmail';
import { oauthClientFromSecrets } from '../src/gmail.js';

const auth = oauthClientFromSecrets(process.env.SECRETS_DIR ?? 'secrets');
const service = gmail({ version: 'v1', auth });
await service.users.getProfile({ userId: 'me' }, { retry: false });
console.log('Gmail profile request succeeded. No messages were read or modified.');
