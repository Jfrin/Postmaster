import { loadConfigFile } from './config.js';
import { createDemoServer } from './demo/server.js';

const origin = process.env.DEMO_ORIGIN;
if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
  throw new Error('DEMO_ORIGIN must be an exact HTTPS origin');
}
const config = loadConfigFile('config/categories.default.yaml');
createDemoServer(config, origin).listen(8080, '0.0.0.0', () =>
  console.log('Mock demo ready behind proxy'),
);
