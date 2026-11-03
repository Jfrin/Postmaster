// One synthetic classification using the shipped categories; never reads real email.
import { AzureClassifier } from '../src/classifier.js';
import { loadConfigFile } from '../src/config.js';
import type { EmailMessage } from '../src/types.js';

const config = loadConfigFile('config/categories.default.yaml');
const message: EmailMessage = {
  id: 'synthetic',
  threadId: 'synthetic',
  from: 'Shop <orders@example.com>',
  address: 'orders@example.com',
  domain: 'example.com',
  subject: 'Your order shipped',
  date: '',
  hasListUnsubscribe: false,
  body: 'Your synthetic order has shipped.',
  labelIds: [],
};

const result = await AzureClassifier.fromEnv().classify(message, config.categories);
console.log(`Azure classification succeeded: ${result.category} (confidence ${result.confidence})`);
