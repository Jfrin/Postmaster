/** One-time operator authorization using a separate installed OAuth client. */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

const expectedEmail = 'joseofrin@gmail.com';
const sendScope = 'https://www.googleapis.com/auth/gmail.send';
// Containers need to listen on their network interface; publish the port on host loopback only.
const bind = z
  .enum(['127.0.0.1', '0.0.0.0'])
  .parse(process.env.NOTIFICATION_AUTH_BIND ?? '127.0.0.1');
const clientPath = process.env.NOTIFICATION_CLIENT_PATH;
const outputPath = process.env.NOTIFICATION_CREDENTIAL_PATH;
if (!clientPath || !outputPath)
  throw new Error('Set NOTIFICATION_CLIENT_PATH and NOTIFICATION_CREDENTIAL_PATH');
const schema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
});
let installed: z.infer<typeof schema>['installed'];
try {
  installed = schema.parse(JSON.parse(readFileSync(clientPath, 'utf8')) as unknown).installed;
} catch {
  throw new Error('invalid notification client file');
}
const redirect = 'http://127.0.0.1:3001';
const client = new OAuth2Client(installed.client_id, installed.client_secret, redirect);
const state = randomBytes(32).toString('base64url');
const nonce = randomBytes(32).toString('base64url');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['openid', 'email', sendScope],
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: CodeChallengeMethod.S256,
});
let finishing = false;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const request = new URL(req.url ?? '/', redirect);
  const provided = request.searchParams.get('state') ?? '';
  const left = Buffer.from(provided);
  const right = Buffer.from(state);
  const codes = request.searchParams.getAll('code');
  if (
    finishing ||
    request.pathname !== '/' ||
    request.searchParams.getAll('state').length !== 1 ||
    left.length !== right.length ||
    !timingSafeEqual(left, right) ||
    codes.length !== 1
  ) {
    res.writeHead(400).end('Invalid or expired authorization response.');
    return;
  }
  finishing = true;
  try {
    const { tokens } = await client.getToken({ code: codes[0]!, codeVerifier: verifier });
    if (!tokens.refresh_token || !tokens.id_token || !tokens.scope)
      throw new Error('missing authorization');
    const scopes = tokens.scope.split(' ');
    if (
      !scopes.includes(sendScope) ||
      scopes.some(
        (scope) =>
          ![
            'openid',
            'email',
            'https://www.googleapis.com/auth/userinfo.email',
            sendScope,
          ].includes(scope),
      )
    )
      throw new Error('unexpected authorization scopes');
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: installed.client_id,
    });
    const identity = ticket.getPayload();
    if (
      !identity?.email_verified ||
      identity.email?.toLowerCase() !== expectedEmail ||
      identity.nonce !== nonce
    )
      throw new Error('wrong Google account');
    writeFileSync(
      outputPath,
      JSON.stringify({
        client_id: installed.client_id,
        client_secret: installed.client_secret,
        refresh_token: tokens.refresh_token,
        email: expectedEmail,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    res.writeHead(200).end('Authorization saved. You may close this tab.');
    console.log('Notification authorization saved to the specified private file.');
  } catch {
    res.writeHead(400).end('Authorization failed. Check the account and scopes, then retry.');
    console.error('Notification authorization failed; no credential was saved.');
  } finally {
    server.close();
  }
});
server.listen(3001, bind, () =>
  console.log(`Open this URL in your browser and authorize ${expectedEmail}:\n${url}`),
);
