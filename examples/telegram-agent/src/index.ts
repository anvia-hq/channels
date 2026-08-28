import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createChannelAgent } from "@anvia/channel-agent";
import { Agent } from "@anvia/core";
import { SqliteMemoryClient } from "@anvia/memory-sqlite";
import { OpenAIClient } from "@anvia/openai";
import { telegram } from "@anvia/telegram";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const telegramToken = requiredEnvironmentVariable("TELEGRAM_BOT_TOKEN");
const openAiApiKey = requiredEnvironmentVariable("OPENAI_API_KEY");
const openAiBaseUrl = process.env.OPENAI_BASE_URL?.trim() || undefined;
const modelId = process.env.OPENAI_MODEL?.trim() || "gpt-5.6";
const memoryPath = process.env.ANVIA_MEMORY_PATH?.trim() || "./data/telegram-agent.sqlite";

await mkdir(dirname(memoryPath), { recursive: true });

const memoryClient = new SqliteMemoryClient({ path: memoryPath });
const memoryStore = memoryClient.memoryStore();
await memoryStore.ensure();

let openAi: OpenAIClient;
if (openAiBaseUrl === undefined) {
  openAi = new OpenAIClient({ apiKey: openAiApiKey });
} else {
  openAi = new OpenAIClient({ apiKey: openAiApiKey, baseUrl: openAiBaseUrl });
}

const agent = new Agent({
  id: "telegram-assistant",
  model: openAi.completionModel({ modelId, api: "responses" }),
  instructions:
    "You are a concise and helpful assistant. Answer in the language used by the person messaging you.",
  memory: {
    store: memoryStore,
    savePolicy: "turn",
  },
});

const channel = telegram({
  token: telegramToken,
  onError(error, context) {
    process.stderr.write(`[telegram:${context.operation}] ${errorMessage(error)}\n`);
  },
});

const channelAgent = createChannelAgent({
  channel,
  agent,
  streaming: {
    placeholder: "Thinking…",
    editIntervalMs: 750,
  },
  onError(error, context) {
    process.stderr.write(`[channel-agent:${context.stage}] ${errorMessage(error)}\n`);
  },
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  shutdownPromise ??= (async () => {
    process.stdout.write(`\nReceived ${signal}; stopping Telegram agent…\n`);

    try {
      await channelAgent.stop();
    } finally {
      await memoryClient.close();
    }
  })();

  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      process.stderr.write(`Shutdown failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  });
}

try {
  await channelAgent.start();
  process.stdout.write(`Telegram agent is running with ${modelId}. Press Ctrl+C to stop.\n`);
} catch (error) {
  await memoryClient.close();
  throw error;
}
