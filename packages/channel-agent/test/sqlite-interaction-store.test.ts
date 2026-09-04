import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteChannelAgentInteractionStore } from "../src/index.js";
import { agentApproval } from "./helpers.js";

describe("SqliteChannelAgentInteractionStore", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists and atomically takes a continuation", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction") throw new Error("Expected an interaction outcome");
    const pending = {
      continuation: outcome.continuation,
      interaction: outcome.interaction,
      actionToken: "opaque-token",
    };
    const store = new SqliteChannelAgentInteractionStore({ database: ":memory:" });

    store.set("conversation", pending);

    expect(store.get("conversation")).toEqual(pending);
    expect(store.take({ key: "conversation", interactionId: "wrong-interaction" })).toBeUndefined();
    expect(store.take({ key: "conversation", interactionId: outcome.interaction.id })).toEqual(
      pending,
    );
    expect(store.get("conversation")).toBeUndefined();
    store.close();
  });

  it("treats expired pending interactions as absent", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction") throw new Error("Expected an interaction outcome");
    const expired = {
      continuation: outcome.continuation,
      interaction: outcome.interaction,
      expiresAt: Date.now() - 1,
    };
    const store = new SqliteChannelAgentInteractionStore({ database: ":memory:" });

    store.set("conversation", expired);
    expect(store.get("conversation")).toBeUndefined();
    expect(store.get("conversation")).toBeUndefined();
    expect(
      store.take({ key: "conversation", interactionId: outcome.interaction.id }),
    ).toBeUndefined();

    const live = {
      continuation: outcome.continuation,
      interaction: outcome.interaction,
      expiresAt: Date.now() + 60_000,
    };
    store.set("conversation", live);
    expect(store.get("conversation")).toEqual(live);
    expect(store.take({ key: "conversation", interactionId: outcome.interaction.id })).toEqual(
      live,
    );
    store.close();
  });

  it("rejects unsafe table names", () => {
    expect(
      () =>
        new SqliteChannelAgentInteractionStore({
          database: ":memory:",
          table: "interactions; DROP TABLE interactions",
        }),
    ).toThrow("table name is invalid");
  });

  it("persists continuations across close and reopen", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction") throw new Error("Expected an interaction outcome");
    const pending = { continuation: outcome.continuation, interaction: outcome.interaction };
    const directory = mkdtempSync(join(tmpdir(), "anvia-channel-agent-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "interactions.sqlite");

    const first = new SqliteChannelAgentInteractionStore({ database: databasePath });
    first.set("conversation", pending);
    first.close();

    const reopened = new SqliteChannelAgentInteractionStore({ database: databasePath });
    expect(reopened.get("conversation")).toEqual(pending);
    reopened.close();
  });

  it("rejects corrupted persisted JSON", () => {
    const database = new DatabaseSync(":memory:");
    const store = new SqliteChannelAgentInteractionStore({ database, table: "interactions" });
    database
      .prepare(
        `INSERT INTO interactions (interaction_key, interaction_id, pending_json)
         VALUES (?, ?, ?)`,
      )
      .run("conversation", "interaction-1", "not-json");

    expect(() => store.get("conversation")).toThrow("invalid JSON");
    database.close();
  });
});
