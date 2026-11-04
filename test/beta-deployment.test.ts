import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BetaAccessStore } from '../src/beta/access.js';
import { createDeploymentRuntime } from '../src/beta/deployment.js';

const origin = 'https://beta.example.com';

function fixture(dir: string): NodeJS.ProcessEnv {
  const identity = join(dir, 'identity.json');
  const gmail = join(dir, 'gmail.json');
  const client = (id: string, callback: string) =>
    JSON.stringify({
      web: {
        client_id: id,
        client_secret: 'synthetic-secret',
        project_id: id,
        redirect_uris: [`${origin}${callback}`],
      },
    });
  writeFileSync(identity, client('identity', '/auth/google/callback'));
  writeFileSync(gmail, client('gmail', '/auth/google/gmail/callback'));
  return {
    BETA_ORIGIN: origin,
    BETA_DATABASE_PATH: join(dir, 'beta.db'),
    BETA_IDENTITY_CLIENT_PATH: identity,
    BETA_GMAIL_CLIENT_PATH: gmail,
    BETA_VAULT_NAME: 'beta-test',
    BETA_VAULT_SECRET: 'beta-key',
    BETA_VAULT_VERSION: 'a'.repeat(32),
    BETA_ADMIN_SUBJECT: 'verified-owner-subject',
    BETA_ADMIN_EMAIL: 'owner@example.com',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    AZURE_OPENAI_API_KEY: 'synthetic-key',
    AZURE_OPENAI_DEPLOYMENT: 'test',
  };
}

function fakeVault(): typeof fetch {
  const key = randomBytes(32).toString('base64');
  return async (input) =>
    String(input).includes('169.254.169.254')
      ? new Response(JSON.stringify({ access_token: 'synthetic' }))
      : new Response(JSON.stringify({ value: key }));
}

describe('beta deployment wiring', () => {
  it('bootstraps only the configured admin and starts on loopback, stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-deploy-'));
    const env = fixture(dir);
    const { runtime, port, host } = await createDeploymentRuntime(env, fakeVault());
    const access = new BetaAccessStore(env.BETA_DATABASE_PATH!);
    try {
      expect(port).toBe(8081);
      expect(host).toBe('127.0.0.1');
      expect(access.isAdmin('verified-owner-subject')).toBe(true);
      expect(access.runnableUsers(Date.now())).toEqual([]);
      await runtime.start(0);
      expect(runtime.scheduler.status().online).toBe(true);
      expect(runtime.server.address()).toMatchObject({ address: '127.0.0.1' });
      await runtime.close();
      const again = await createDeploymentRuntime(env, fakeVault());
      await again.runtime.close();
      await expect(
        createDeploymentRuntime({ ...env, BETA_ADMIN_SUBJECT: 'other' }, fakeVault()),
      ).rejects.toThrow('already bootstrapped');
    } finally {
      await runtime.close();
      access.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('binds the Docker network only when explicitly configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-deploy-bind-'));
    const env = { ...fixture(dir), BETA_BIND: '0.0.0.0' };
    const { runtime, host } = await createDeploymentRuntime(env, fakeVault());
    try {
      await runtime.start(0, host);
      expect(runtime.server.address()).toMatchObject({ address: '0.0.0.0' });
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('rejects missing credentials, wrong callbacks and same-project clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postmaster-deploy-'));
    const env = fixture(dir);
    try {
      await expect(
        createDeploymentRuntime({ ...env, BETA_ADMIN_EMAIL: undefined }, fakeVault()),
      ).rejects.toThrow();
      await expect(
        createDeploymentRuntime({ ...env, BETA_IDENTITY_CLIENT_PATH: 'missing' }, fakeVault()),
      ).rejects.toThrow('invalid Google web client');
      await expect(
        createDeploymentRuntime({ ...env, BETA_ORIGIN: 'https://other.example.com' }, fakeVault()),
      ).rejects.toThrow('invalid Google web client');
      writeFileSync(
        env.BETA_GMAIL_CLIENT_PATH!,
        JSON.stringify({
          web: {
            client_id: 'gmail',
            client_secret: 'synthetic',
            project_id: 'identity',
            redirect_uris: [`${origin}/auth/google/gmail/callback`],
          },
        }),
      );
      await expect(createDeploymentRuntime(env, fakeVault())).rejects.toThrow('separate Google');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
