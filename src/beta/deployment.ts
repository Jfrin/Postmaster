import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AzureClassifier } from '../classifier.js';
import { BetaAccessStore } from './access.js';
import { GoogleGmailConsentProvider } from './google-gmail-consent.js';
import { GoogleIdentityProvider } from './google-identity.js';
import { gmailNotificationSender } from './notifications.js';
import { restrictIdentityProvider } from './identity-flow.js';
import { createAzureBetaRuntime } from './runtime.js';
import { googleGmailServiceFactory } from './worker.js';

const Env = z.object({
  BETA_ORIGIN: z.string().min(1),
  BETA_BASE_PATH: z.string().default('/beta'),
  BETA_DATABASE_PATH: z.string().min(1),
  BETA_DEFAULT_CONFIG_PATH: z.string().default('config/categories.default.yaml'),
  BETA_IDENTITY_CLIENT_PATH: z.string().min(1),
  BETA_GMAIL_CLIENT_PATH: z.string().min(1),
  BETA_VAULT_NAME: z.string().min(1),
  BETA_VAULT_SECRET: z.string().min(1),
  BETA_VAULT_VERSION: z.string().min(1),
  BETA_ADMIN_SUBJECT: z.string().min(1).max(255),
  BETA_ADMIN_EMAIL: z.string().email().max(320),
  BETA_OWNER_ONLY: z.enum(['true', 'false']).default('false'),
  BETA_APPLICATION_ACCESS: z.enum(['true', 'false']).default('false'),
  BETA_NOTIFICATION_CREDENTIAL_PATH: z.string().min(1).optional(),
  BETA_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  BETA_BIND: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
});

const WebClient = z.object({
  web: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    project_id: z.string().min(1),
    redirect_uris: z.array(z.string()).min(1),
  }),
});

function webClient(path: string, callback: string) {
  try {
    const input = readFileSync(path, 'utf8');
    if (Buffer.byteLength(input) > 100_000) throw new Error('client file too large');
    const client = WebClient.parse(JSON.parse(input)).web;
    if (!client.redirect_uris.includes(callback)) throw new Error('callback not registered');
    return client;
  } catch {
    // Avoid exposing credential-file contents or provider errors in logs.
    throw new Error('invalid Google web client or callback');
  }
}

/** Deployment wiring only. Do not expose until consent races and operations are reviewed. */
export async function createDeploymentRuntime(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
) {
  const options = Env.parse(env);
  const identityCallback = `${options.BETA_ORIGIN}/auth/google/callback`;
  const gmailCallback = `${options.BETA_ORIGIN}/auth/google/gmail/callback`;
  const identity = webClient(options.BETA_IDENTITY_CLIENT_PATH, identityCallback);
  const gmail = webClient(options.BETA_GMAIL_CLIENT_PATH, gmailCallback);
  if (identity.client_id === gmail.client_id || identity.project_id === gmail.project_id)
    throw new Error('separate Google identity and Gmail projects required');
  const defaults = readFileSync(options.BETA_DEFAULT_CONFIG_PATH, 'utf8');
  const identityProvider = new GoogleIdentityProvider(
    identity.client_id,
    identity.client_secret,
    identityCallback,
  );
  const ownerOnly = options.BETA_OWNER_ONLY === 'true';
  const applicationAccess = options.BETA_APPLICATION_ACCESS === 'true';
  if (applicationAccess && !ownerOnly)
    throw new Error('application access requires owner-only mode');
  const runtime = await createAzureBetaRuntime(
    {
      databasePath: options.BETA_DATABASE_PATH,
      origin: options.BETA_ORIGIN,
      basePath: options.BETA_BASE_PATH,
      adminIdentity: { subject: options.BETA_ADMIN_SUBJECT, email: options.BETA_ADMIN_EMAIL },
      defaultConfigYaml: defaults,
      identityProvider:
        ownerOnly && !applicationAccess
          ? restrictIdentityProvider(identityProvider, options.BETA_ADMIN_SUBJECT)
          : identityProvider,
      ...(ownerOnly ? { onlySubject: options.BETA_ADMIN_SUBJECT } : {}),
      applicationAccess,
      ...(options.BETA_NOTIFICATION_CREDENTIAL_PATH
        ? {
            notificationSender: gmailNotificationSender(
              options.BETA_NOTIFICATION_CREDENTIAL_PATH,
              options.BETA_ADMIN_EMAIL,
              `${options.BETA_ORIGIN}${options.BETA_BASE_PATH}`,
            ),
          }
        : {}),
      gmailConsentProvider: new GoogleGmailConsentProvider(
        gmail.client_id,
        gmail.client_secret,
        gmailCallback,
      ),
      makeGmailService: googleGmailServiceFactory(gmail.client_id, gmail.client_secret),
      classifier: AzureClassifier.fromEnv(env),
      vaultName: options.BETA_VAULT_NAME,
      secretName: options.BETA_VAULT_SECRET,
      secretVersion: options.BETA_VAULT_VERSION,
    },
    fetcher,
  );
  try {
    // Operator-provided, verified Google subject; never accept an HTTP-supplied admin.
    const access = new BetaAccessStore(options.BETA_DATABASE_PATH);
    try {
      if (!access.isAdmin(options.BETA_ADMIN_SUBJECT))
        access.bootstrapAdmin(options.BETA_ADMIN_SUBJECT);
    } finally {
      access.close();
    }
    return { runtime, port: options.BETA_PORT, host: options.BETA_BIND };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
