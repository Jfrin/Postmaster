import type { Classifier } from '../classifier.js';
import { BetaAccessStore } from './access.js';
import { BetaActivityStore } from './activity.js';
import { GmailConsentFlow, type GmailConsentProvider } from './gmail-consent-flow.js';
import { GmailConsentStateStore } from './gmail-consent-state.js';
import { IdentityFlow, type IdentityProvider } from './identity-flow.js';
import { loadAzureVaultKey } from './key-vault.js';
import { IdentityLoginStateStore } from './oauth-state.js';
import { BetaScheduler } from './scheduler.js';
import { createBetaServer } from './server.js';
import { BetaSessionStore } from './session-store.js';
import { GmailTokenVault } from './token-vault.js';
import { BetaUserConfigStore } from './user-config.js';
import { BetaCycleRunner, type GmailServiceFactory } from './worker.js';

export interface BetaRuntimeOptions {
  databasePath: string;
  vaultKey: Uint8Array;
  defaultConfigYaml: string;
  origin: string;
  basePath?: string;
  identityProvider: IdentityProvider;
  gmailConsentProvider: GmailConsentProvider;
  makeGmailService: GmailServiceFactory;
  classifier: Classifier;
  now?: () => number;
  maxConcurrent?: number;
  tickMs?: number;
}

/** Local wiring for managed-key deployments; the caller still owns all deployment controls. */
export async function createAzureBetaRuntime(
  options: Omit<BetaRuntimeOptions, 'vaultKey'> & {
    vaultName: string;
    secretName: string;
    secretVersion: string;
  },
  fetcher: typeof fetch = fetch,
) {
  const key = await loadAzureVaultKey(
    options.vaultName,
    options.secretName,
    options.secretVersion,
    fetcher,
  );
  try {
    return createBetaRuntime({ ...options, vaultKey: key });
  } finally {
    key.fill(0);
  }
}

/**
 * Local integration prototype, not a production entry point. Providers, admin bootstrap,
 * protected keys, TLS/proxy configuration and retention scheduling remain the caller's
 * responsibility. No real users or Gmail accounts until security review is complete.
 */
export function createBetaRuntime(options: BetaRuntimeOptions) {
  if (!options.databasePath || options.databasePath === ':memory:')
    throw new Error('shared database file required');
  const now = options.now ?? Date.now;
  const closers: (() => void)[] = [];
  const own = <T extends { close(): void }>(resource: T): T => {
    closers.unshift(() => resource.close());
    return resource;
  };

  try {
    const access = own(new BetaAccessStore(options.databasePath));
    const vault = own(new GmailTokenVault(options.databasePath, options.vaultKey));
    const config = own(new BetaUserConfigStore(options.databasePath, options.defaultConfigYaml));
    const activity = own(new BetaActivityStore(options.databasePath));
    const sessions = own(new BetaSessionStore(options.databasePath));
    const identityStates = own(new IdentityLoginStateStore(options.databasePath));
    const consentStates = own(new GmailConsentStateStore(options.databasePath));
    const identity = new IdentityFlow(identityStates, sessions, options.identityProvider);
    const consent = new GmailConsentFlow(
      consentStates,
      access,
      vault,
      options.gmailConsentProvider,
      now,
    );
    const runner = own(
      new BetaCycleRunner({
        databasePath: options.databasePath,
        vaultKey: options.vaultKey,
        defaultConfigYaml: options.defaultConfigYaml,
        makeGmailService: options.makeGmailService,
        classifier: options.classifier,
        now: () => new Date(now()),
      }),
    );
    const scheduler = new BetaScheduler(access, runner, now, options.maxConcurrent, options.tickMs);
    const server = createBetaServer({
      store: access,
      origin: options.origin,
      basePath: options.basePath,
      identityFlow: identity,
      gmailConsentFlow: consent,
      userConfigStore: config,
      activityStore: activity,
      processingOnline: () => scheduler.status().online,
      authenticate: async (req) => sessions.authenticate(req.headers.cookie, now()),
      now,
    });
    let startup: Promise<void> | null = null;
    let shutdown: Promise<void> | null = null;
    let closing = false;
    let started = false;

    const dispose = (): Promise<void> => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        const results = await Promise.allSettled([
          scheduler.stop(),
          new Promise<void>((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
        ]);
        for (const close of closers) {
          try {
            close();
          } catch (error) {
            results.push({ status: 'rejected', reason: error });
          }
        }
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return shutdown;
    };

    return {
      // Exposed for local integration tests; never accept HTTP-supplied subjects here.
      scheduler,
      server,
      start(port = 0): Promise<void> {
        if (startup || closing)
          return Promise.reject(new Error('runtime already started or closed'));
        startup = (async () => {
          try {
            scheduler.start();
            await new Promise<void>((resolve, reject) => {
              const onError = (error: Error) => reject(error);
              server.once('error', onError);
              server.listen(port, '127.0.0.1', () => {
                server.off('error', onError);
                resolve();
              });
            });
            started = true;
          } catch (error) {
            closing = true;
            try {
              await dispose();
            } catch {
              // Preserve the startup failure.
            }
            throw error;
          }
        })();
        return startup;
      },
      async close(): Promise<void> {
        closing = true;
        if (startup && !started) await startup.catch(() => {});
        await dispose();
      },
    };
  } catch (error) {
    for (const close of closers) {
      try {
        close();
      } catch {
        // Preserve the construction failure.
      }
    }
    throw error;
  }
}
