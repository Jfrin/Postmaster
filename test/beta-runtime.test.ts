import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockClassifier } from '../src/classifier.js';
import { BetaAccessStore } from '../src/beta/access.js';
import {
  createAzureBetaRuntime,
  createBetaRuntime,
  type BetaRuntimeOptions,
} from '../src/beta/runtime.js';
import { GmailTokenVault } from '../src/beta/token-vault.js';

const now = Date.parse('2026-11-04T10:00:00Z');

function options(databasePath: string, vaultKey: Uint8Array): BetaRuntimeOptions {
  return {
    databasePath,
    vaultKey,
    defaultConfigYaml: readFileSync('config/categories.default.yaml', 'utf8'),
    origin: 'https://beta.example.com',
    identityProvider: {
      authorizationUrl: () => 'https://example.com/',
      exchange: async () => ({ subject: 'alice', verifiedEmail: 'alice@example.com' }),
    },
    gmailConsentProvider: {
      authorizationUrl: () => 'https://example.com/',
      exchange: async () => 'synthetic',
      revoke: async () => {},
    },
    makeGmailService: () => {
      throw new Error('unexpected Gmail call');
    },
    classifier: new MockClassifier(),
    now: () => now,
  };
}

describe('local beta runtime lifecycle', () => {
  it('creates the runtime with a managed vault key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-runtime-azure-'));
    const key = randomBytes(32);
    const config = options(join(dir, 'beta.db'), key);
    const fetcher: typeof fetch = async (input) =>
      String(input).includes('169.254.169.254')
        ? new Response(JSON.stringify({ access_token: 'synthetic' }))
        : new Response(JSON.stringify({ value: key.toString('base64') }));
    const runtime = await createAzureBetaRuntime(
      {
        ...config,
        vaultName: 'postmaster-test',
        secretName: 'beta-key',
        secretVersion: 'a'.repeat(32),
      },
      fetcher,
    );
    try {
      await runtime.start();
      expect(runtime.scheduler.status().online).toBe(true);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects unsafe mount paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-runtime-path-'));
    try {
      const config = options(join(dir, 'beta.db'), randomBytes(32));
      for (const basePath of ['/beta/', '//evil', '/beta?x', '/</script>']) {
        expect(() => createBetaRuntime({ ...config, basePath })).toThrow('invalid beta mount path');
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('binds only loopback and requires a fresh Start after shutdown and restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-runtime-'));
    const path = join(dir, 'beta.db');
    const key = randomBytes(32);
    const access = new BetaAccessStore(path);
    const vault = new GmailTokenVault(path, key);
    const first = createBetaRuntime(options(path, key));
    const second = createBetaRuntime(options(path, key));
    try {
      access.bootstrapAdmin('admin');
      access.requestAccess('alice', 'alice@example.com', now);
      access.approve('admin', 'alice', now + 60_000, 100, now);
      vault.save('alice', 'synthetic');
      await first.start();
      expect((first.server.address() as AddressInfo).address).toBe('127.0.0.1');
      await expect(second.start()).rejects.toThrow('scheduler lease unavailable');
      access.startProcessing('alice', now);
      await Promise.all([first.close(), first.close()]);
      expect(access.processingRequested('alice')).toBe(false);
      expect(first.server.listening).toBe(false);
      await expect(first.start()).rejects.toThrow('already started or closed');
      const restarted = createBetaRuntime(options(path, key));
      try {
        await restarted.start();
        expect(restarted.scheduler.status().online).toBe(true);
        expect(access.processingRequested('alice')).toBe(false);
      } finally {
        await restarted.close();
      }
    } finally {
      await first.close();
      await second.close();
      vault.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('releases its scheduler and resources when the loopback port is occupied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-runtime-bind-'));
    const path = join(dir, 'beta.db');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const runtime = createBetaRuntime(options(path, randomBytes(32)));
    const access = new BetaAccessStore(path);
    try {
      await expect(runtime.start((blocker.address() as AddressInfo).port)).rejects.toThrow();
      expect(runtime.server.listening).toBe(false);
      const lease = access.acquireScheduler('z'.repeat(32), now, 1000);
      expect(lease).not.toBeNull();
      access.releaseScheduler(lease!, now);
      await runtime.close();
    } finally {
      await runtime.close();
      access.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(dir, { recursive: true });
    }
  });

  it('handles close while startup is pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-runtime-close-'));
    const runtime = createBetaRuntime(options(join(dir, 'beta.db'), randomBytes(32)));
    try {
      const starting = runtime.start();
      const closing = runtime.close();
      await starting;
      await closing;
      expect(runtime.server.listening).toBe(false);
      await expect(runtime.start()).rejects.toThrow('already started or closed');
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('waits for an in-flight identity callback before closing its stores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-runtime-drain-'));
    const config = options(join(dir, 'beta.db'), randomBytes(32));
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    config.identityProvider.authorizationUrl = (state) => `https://example.com/?state=${state}`;
    config.identityProvider.exchange = async () => {
      entered();
      await waiting;
      return { subject: 'alice', verifiedEmail: 'alice@example.com' };
    };
    const runtime = createBetaRuntime(config);
    try {
      await runtime.start();
      const port = (runtime.server.address() as AddressInfo).port;
      const send = (path: string, cookie = '') =>
        new Promise<{ status: number; location?: string; cookies?: string[] }>(
          (resolve, reject) => {
            const req = request(
              {
                host: '127.0.0.1',
                port,
                path,
                headers: { Host: 'beta.example.com', Cookie: cookie },
              },
              (res) => {
                res.resume();
                res.on('end', () =>
                  resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    cookies: res.headers['set-cookie'],
                  }),
                );
              },
            );
            req.on('error', reject);
            req.end();
          },
        );
      const login = await send('/auth/google/start');
      const state = new URL(login.location!).searchParams.get('state');
      const callback = send(
        `/auth/google/callback?state=${state}&code=synthetic`,
        login.cookies![0]!.split(';')[0],
      );
      await started;
      let closed = false;
      const closing = runtime.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(runtime.scheduler.status().online).toBe(false);
      release();
      expect((await callback).status).toBe(302);
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      await runtime.close();
      rmSync(dir, { recursive: true });
    }
  });
});
