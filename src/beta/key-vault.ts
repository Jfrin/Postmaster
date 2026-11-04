/** Fetch a 256-bit vault key using the VM's system-assigned managed identity. */
export async function loadAzureVaultKey(
  vaultName: string,
  secretName: string,
  secretVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(vaultName))
    throw new Error('invalid Azure vault name');
  if (!/^[a-zA-Z0-9-]{1,127}$/.test(secretName)) throw new Error('invalid Azure secret name');
  if (!/^[a-fA-F0-9]{32}$/.test(secretVersion)) throw new Error('invalid Azure secret version');

  try {
    const tokenUrl = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
    tokenUrl.searchParams.set('api-version', '2018-02-01');
    tokenUrl.searchParams.set('resource', 'https://vault.azure.net');
    const tokenResponse = await fetcher(tokenUrl, {
      headers: { Metadata: 'true' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!tokenResponse.ok) throw new Error('identity unavailable');
    const identity: unknown = await tokenResponse.json();
    if (
      !identity ||
      typeof identity !== 'object' ||
      !('access_token' in identity) ||
      typeof identity.access_token !== 'string' ||
      !identity.access_token ||
      identity.access_token.length > 16_384 ||
      /[\r\n]/.test(identity.access_token)
    )
      throw new Error('invalid identity response');
    const secretUrl = new URL(
      `https://${vaultName}.vault.azure.net/secrets/${secretName}/${secretVersion}`,
    );
    secretUrl.searchParams.set('api-version', '7.4');
    const secretResponse = await fetcher(secretUrl, {
      headers: { Authorization: `Bearer ${identity.access_token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!secretResponse.ok) throw new Error('key unavailable');
    const secret: unknown = await secretResponse.json();
    if (
      !secret ||
      typeof secret !== 'object' ||
      !('value' in secret) ||
      typeof secret.value !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(secret.value)
    )
      throw new Error('invalid key');
    const key = Buffer.from(secret.value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== secret.value)
      throw new Error('invalid key');
    return key;
  } catch {
    // Provider responses and URLs may contain credentials; never forward raw errors.
    throw new Error('unable to load beta vault key');
  }
}
