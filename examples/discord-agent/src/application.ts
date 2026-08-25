import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createChannelAgent } from "@anvia/channel-agent";
import { SqliteMemoryClient } from "@anvia/memory-sqlite";
import { createAgent } from "./agents.js";
import { createDiscordChannel } from "./channels.js";
import { createModel } from "./models.js";
import type { DiscordAgentApplication, DiscordAgentConfig } from "./types.js";

export async function createApplication(
  config: DiscordAgentConfig,
): Promise<DiscordAgentApplication> {
  await mkdir(dirname(config.memoryPath), { recursive: true });

  const memoryClient = new SqliteMemoryClient({ path: config.memoryPath });

  try {
    const memoryStore = memoryClient.memoryStore();
    await memoryStore.ensure();

    const channelAgent = createChannelAgent({
      channel: createDiscordChannel(config),
      agent: createAgent(createModel(config), memoryStore),
      streaming: {
        placeholder: "Thinking…",
        editIntervalMs: 750,
      },
      onError(error, context) {
        process.stderr.write(`[channel-agent:${context.stage}] ${String(error)}\n`);
      },
    });
    let stopPromise: Promise<void> | undefined;

    return {
      modelId: config.modelId,
      async start() {
        if (stopPromise !== undefined) {
          throw new Error("Discord agent application is already stopped");
        }
        await channelAgent.start();
      },
      stop() {
        stopPromise ??= (async () => {
          try {
            await channelAgent.stop();
          } finally {
            await memoryClient.close();
          }
        })();

        return stopPromise;
      },
    };
  } catch (error) {
    await memoryClient.close();
    throw error;
  }
}
