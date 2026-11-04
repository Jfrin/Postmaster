import { createDeploymentRuntime } from './beta/deployment.js';

async function main(): Promise<void> {
  const { runtime, port, host } = await createDeploymentRuntime(process.env);
  await runtime.start(port, host);
  console.log('Beta listening; processing starts stopped');
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void runtime.close().catch(() => {
      console.error('Beta shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(() => {
  // Never log raw provider errors, which can contain credentials.
  console.error('Beta startup failed; check deployment configuration and protected resources');
  process.exitCode = 1;
});
