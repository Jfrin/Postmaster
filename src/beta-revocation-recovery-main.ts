import { recoverRevocationOffline } from './beta/revocation-recovery.js';

try {
  const [subject, confirmation] = process.argv.slice(2);
  if (process.argv.length !== 4 || !subject || !confirmation || !process.env.BETA_DATABASE_PATH)
    throw new Error('database path, subject, and explicit confirmation required');
  recoverRevocationOffline(process.env.BETA_DATABASE_PATH, subject, confirmation, Date.now());
  console.log(
    'Offline local revocation recovery completed. Google revocation was operator-confirmed.',
  );
} catch {
  // Do not expose subjects, credential data, or raw database errors in logs.
  console.error('Offline revocation recovery failed; review the recovery runbook.');
  process.exitCode = 1;
}
