import { createApplication } from "./application.js";
import { loadConfig } from "./config.js";

const application = await createApplication(loadConfig());
let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  shutdownPromise ??= (async () => {
    process.stdout.write(`\nReceived ${signal}; stopping Discord agent…\n`);
    await application.stop();
  })();

  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      process.stderr.write(`Shutdown failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
  });
}

try {
  await application.start();
  process.stdout.write(
    `Discord agent is running with ${application.modelId}. Press Ctrl+C to stop.\n`,
  );
} catch (error) {
  await application.stop();
  throw error;
}
