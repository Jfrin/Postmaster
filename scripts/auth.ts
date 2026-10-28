// Run once on your laptop: npm run auth. Writes secrets/token.json, then copy it to the VM.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { google } from 'googleapis';
import { SCOPES } from '../src/gmail.js';

const PORT = 3000;
const creds = JSON.parse(readFileSync('secrets/credentials.json', 'utf8'));
const c = creds.installed ?? creds.web;
const redirect = `http://localhost:${PORT}`;
const client = new google.auth.OAuth2(c.client_id, c.client_secret, redirect);

const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
console.log(`Open this URL and approve access:\n\n${url}\n`);

const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? '', redirect).searchParams.get('code');
  if (!code) {
    res.end('waiting for code');
    return;
  }
  const { tokens } = await client.getToken(code);
  mkdirSync('secrets', { recursive: true });
  writeFileSync('secrets/token.json', JSON.stringify(tokens, null, 2), { mode: 0o600 });
  res.end('Done. You can close this tab.');
  console.log('Saved secrets/token.json');
  server.close();
});
server.listen(PORT);
