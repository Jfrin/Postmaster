import type { Classifier } from '../classifier.js';
import { BetaAccessStore } from './access.js';
import { BetaActivityStore } from './activity.js';
import { BetaDataPrivacy } from './data-privacy.js';
import { guardBetaClock } from './clock.js';
import { GmailConsentFlow, type GmailConsentProvider } from './gmail-consent-flow.js';
import { GmailConsentStateStore } from './gmail-consent-state.js';
import { IdentityAccessDeniedError, IdentityFlow, type IdentityProvider } from './identity-flow.js';
import { loadAzureVaultKey } from './key-vault.js';
import { IdentityLoginStateStore } from './oauth-state.js';
import { NotificationWorker } from './notifications.js';
import { BetaProcessingEvents } from './processing-events.js';
import { BetaScheduler } from './scheduler.js';
import { createBetaServer } from './server.js';
import { BetaSessionStore } from './session-store.js';
import { deleteStaleGmailTokens } from './token-retention.js';
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
  /** When set, reject any existing session belonging to another Google subject. */
  onlySubject?: string;
  /** Permit a Google-verified, administrator-approved applicant alongside the owner. */
  applicationAccess?: boolean;
  adminIdentity?: { subject: string; email: string };
  gmailConsentProvider: GmailConsentProvider;
  makeGmailService: GmailServiceFactory;
  classifier: Classifier;
  now?: () => number;
  maxConcurrent?: number;
  tickMs?: number;
  notificationSender?: (
    notice: NonNullable<ReturnType<BetaAccessStore['claimNotification']>>,
  ) => Promise<void>;
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
  const now = guardBetaClock(options.now ?? Date.now);
  const closers: (() => void)[] = [];
  const own = <T extends { close(): void }>(resource: T): T => {
    closers.unshift(() => resource.close());
    return resource;
  };

  try {
    const access = own(new BetaAccessStore(options.databasePath, options.vaultKey, now()));
    const notifications = options.notificationSender
      ? new NotificationWorker(access, options.notificationSender, now)
      : null;
    const vault = own(new GmailTokenVault(options.databasePath, options.vaultKey));
    const config = own(new BetaUserConfigStore(options.databasePath, options.defaultConfigYaml));
    const activity = own(new BetaActivityStore(options.databasePath));
    const processingEvents = own(new BetaProcessingEvents(options.databasePath));
    const sessions = own(new BetaSessionStore(options.databasePath));
    const identityStates = own(new IdentityLoginStateStore(options.databasePath));
    const consentStates = own(new GmailConsentStateStore(options.databasePath));
    const privacy = own(new BetaDataPrivacy(options.databasePath, options.vaultKey, now()));
    if (options.applicationAccess && !options.onlySubject)
      throw new Error('application access requires an owner subject');
    const provider = options.applicationAccess
      ? {
          authorizationUrl: options.identityProvider.authorizationUrl.bind(
            options.identityProvider,
          ),
          exchange: async (code: string, verifier: string, nonce: string) => {
            const verified = await options.identityProvider.exchange(code, verifier, nonce);
            if (
              verified.subject !== options.onlySubject &&
              (!verified.emailAuthoritative ||
                !access.claimApplication(verified.subject, verified.verifiedEmail, now()))
            ) {
              if (
                options.adminIdentity &&
                verified.verifiedEmail.toLowerCase() === options.adminIdentity.email.toLowerCase()
              )
                console.warn('beta sign-in: configured admin email matched but subject did not');
              console.warn('beta sign-in: verified identity not admitted');
              throw new IdentityAccessDeniedError('identity is not permitted');
            }
            return verified;
          },
        }
      : options.identityProvider;
    const identity = new IdentityFlow(identityStates, sessions, provider);
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
    const scheduler = new BetaScheduler(
      access,
      runner,
      now,
      options.maxConcurrent,
      options.tickMs,
      (time) => {
        deleteStaleGmailTokens(options.databasePath, time);
        privacy.cleanup(time);
      },
    );
    const server = createBetaServer({
      store: access,
      origin: options.origin,
      adminIdentity: options.adminIdentity,
      basePath: options.basePath,
      identityFlow: identity,
      gmailConsentFlow: consent,
      userConfigStore: config,
      activityStore: activity,
      processingEvents,
      dataPrivacy: privacy,
      processingOnline: () => scheduler.status().online,
      notificationsEnabled: !!notifications,
      authenticate: async (req) => {
        const session = sessions.authenticate(req.headers.cookie, now());
        return session &&
          (!options.onlySubject ||
            session.subject === options.onlySubject ||
            (options.applicationAccess &&
              access.isApplicationAdmitted(session.subject, session.verifiedEmail, now())))
          ? session
          : null;
      },
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
          notifications?.stop() ?? Promise.resolve(),
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
      start(port = 0, host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'): Promise<void> {
        if (startup || closing)
          return Promise.reject(new Error('runtime already started or closed'));
        startup = (async () => {
          try {
            scheduler.start();
            notifications?.start();
            await new Promise<void>((resolve, reject) => {
              const onError = (error: Error) => reject(error);
              server.once('error', onError);
              server.listen(port, host, () => {
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
