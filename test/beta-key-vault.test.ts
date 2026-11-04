import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadAzureVaultKey } from '../src/beta/key-vault.js';

describe('Azure-managed beta vault key', () => {
  const version = 'a'.repeat(32);
  it('uses VM identity to retrieve a 32-byte key from the specified vault', async () => {
    const key = randomBytes(32);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: key.toString('base64') })));
    expect(await loadAzureVaultKey('postmaster-test', 'beta-key', version, fetcher)).toEqual(key);
    const first = new URL(String(fetcher.mock.calls[0]![0]));
    const second = new URL(String(fetcher.mock.calls[1]![0]));
    expect(first.hostname).toBe('169.254.169.254');
    expect(first.searchParams.get('resource')).toBe('https://vault.azure.net');
    expect(second.hostname).toBe('postmaster-test.vault.azure.net');
    expect(second.pathname).toBe(`/secrets/beta-key/${version}`);
    expect(fetcher.mock.calls[1]![1]?.headers).toEqual({ Authorization: 'Bearer synthetic-token' });
    expect(fetcher.mock.calls[1]![1]?.redirect).toBe('error');
  });

  it('fails closed without exposing provider errors or accepting malformed keys', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-secret'));
    await expect(
      loadAzureVaultKey('postmaster-test', 'beta-key', version, fetcher),
    ).rejects.toThrow('unable to load beta vault key');
    const invalid = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 'wrong' })));
    await expect(
      loadAzureVaultKey('postmaster-test', 'beta-key', version, invalid),
    ).rejects.toThrow('unable to load beta vault key');
    await expect(loadAzureVaultKey('bad.example', 'key', version, fetcher)).rejects.toThrow(
      'invalid',
    );
    await expect(loadAzureVaultKey('valid-name', '../key', version, fetcher)).rejects.toThrow(
      'invalid',
    );
    await expect(loadAzureVaultKey('valid-name', 'key', 'latest', fetcher)).rejects.toThrow(
      'invalid',
    );
  });
});
