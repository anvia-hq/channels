import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  parseAgentContinuation,
  parseAgentInteractionRequest,
} from "@anvia/core/agent/interactions";
import { interactionExpired } from "./interactions.js";
import type {
  ChannelAgentInteractionStore,
  PendingChannelAgentInteraction,
} from "./interactions.js";

const DEFAULT_TABLE = "anvia_channel_interactions";

export type SqliteChannelAgentInteractionStoreOptions = Readonly<{
  database: string | DatabaseSync;
  table?: string;
}>;

/** Durable, process-safe continuation storage backed by SQLite. */
export class SqliteChannelAgentInteractionStore implements ChannelAgentInteractionStore {
  private readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private readonly table: string;

  constructor(options: SqliteChannelAgentInteractionStoreOptions) {
    this.table = sqliteIdentifier(options.table ?? DEFAULT_TABLE);
    this.ownsDatabase = typeof options.database === "string";
    if (typeof options.database === "string" && options.database.length === 0) {
      throw new TypeError("SQLite interaction database path must not be empty");
    }
    this.database =
      typeof options.database === "string" ? new DatabaseSync(options.database) : options.database;
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          interaction_key TEXT PRIMARY KEY,
          interaction_id TEXT NOT NULL,
          pending_json TEXT NOT NULL
        ) STRICT
      `);
    } catch (error) {
      if (this.ownsDatabase && this.database.isOpen) this.database.close();
      throw error;
    }
  }

  get(key: string): PendingChannelAgentInteraction | undefined {
    validateKey(key);
    const row = this.database
      .prepare(`SELECT pending_json FROM ${this.table} WHERE interaction_key = ?`)
      .get(key);
    if (row === undefined) return undefined;
    const pending = parsePending(row.pending_json);
    if (interactionExpired(pending)) {
      this.delete({ key, interactionId: pending.interaction.id });
      return undefined;
    }
    return pending;
  }

  set(key: string, pending: PendingChannelAgentInteraction): void {
    validateKey(key);
    const serialized = serializePending(pending);
    this.database
      .prepare(
        `INSERT INTO ${this.table} (interaction_key, interaction_id, pending_json)
         VALUES (?, ?, ?)
         ON CONFLICT(interaction_key) DO UPDATE SET
           interaction_id = excluded.interaction_id,
           pending_json = excluded.pending_json`,
      )
      .run(key, pending.interaction.id, serialized);
  }

  take({
    key,
    interactionId,
  }: Readonly<{ key: string; interactionId: string }>): PendingChannelAgentInteraction | undefined {
    validateKey(key);
    validateKey(interactionId, "Channel interaction ID");
    const row = this.database
      .prepare(
        `DELETE FROM ${this.table}
         WHERE interaction_key = ? AND interaction_id = ?
         RETURNING pending_json`,
      )
      .get(key, interactionId);
    if (row === undefined) return undefined;
    const pending = parsePending(row.pending_json);
    return interactionExpired(pending) ? undefined : pending;
  }
  delete({ key, interactionId }: Readonly<{ key: string; interactionId: string }>): void {
    validateKey(key);
    validateKey(interactionId, "Channel interaction ID");
    this.database
      .prepare(
        `DELETE FROM ${this.table}
         WHERE interaction_key = ? AND interaction_id = ?`,
      )
      .run(key, interactionId);
  }

  close(): void {
    if (this.ownsDatabase && this.database.isOpen) this.database.close();
  }
}

function serializePending(pending: PendingChannelAgentInteraction): string {
  const continuation = parseAgentContinuation(pending.continuation);
  const interaction = parseAgentInteractionRequest(pending.interaction);
  if (!isDeepStrictEqual(continuation.interaction, interaction)) {
    throw new TypeError("Channel continuation and interaction must match");
  }
  if (
    pending.actionToken !== undefined &&
    (typeof pending.actionToken !== "string" || pending.actionToken.length === 0)
  ) {
    throw new TypeError("Channel interaction action token must not be empty");
  }
  const value: {
    continuation: typeof continuation;
    interaction: typeof interaction;
    actionToken?: string;
    expiresAt?: number;
  } = {
    continuation,
    interaction,
  };
  if (pending.actionToken !== undefined) value.actionToken = pending.actionToken;
  if (pending.expiresAt !== undefined) {
    if (
      typeof pending.expiresAt !== "number" ||
      !Number.isSafeInteger(pending.expiresAt) ||
      pending.expiresAt <= 0
    ) {
      throw new TypeError("Channel interaction expiry must be a positive epoch");
    }
    value.expiresAt = pending.expiresAt;
  }
  return JSON.stringify(value);
}

function parsePending(value: unknown): PendingChannelAgentInteraction {
  if (typeof value !== "string") throw new TypeError("Stored channel interaction is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError("Stored channel interaction is invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new TypeError("Stored channel interaction is invalid");
  const continuation = parseAgentContinuation(parsed.continuation);
  const interaction = parseAgentInteractionRequest(parsed.interaction);
  if (!isDeepStrictEqual(continuation.interaction, interaction)) {
    throw new TypeError("Stored channel continuation and interaction do not match");
  }
  const actionToken = parsed.actionToken;
  if (actionToken !== undefined && (typeof actionToken !== "string" || actionToken.length === 0)) {
    throw new TypeError("Stored channel interaction action token is invalid");
  }
  const expiresAt = parsed.expiresAt;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt))
  ) {
    throw new TypeError("Stored channel interaction expiry is invalid");
  }
  const pending: {
    continuation: typeof continuation;
    interaction: typeof interaction;
    actionToken?: string;
    expiresAt?: number;
  } = { continuation, interaction };
  if (actionToken !== undefined) pending.actionToken = actionToken;
  if (expiresAt !== undefined) pending.expiresAt = expiresAt;
  return pending;
}

function sqliteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError("SQLite interaction table name is invalid");
  }
  return value;
}

function validateKey(value: string, label = "Channel interaction key"): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
