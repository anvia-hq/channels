import { validateChannelMessage } from "./messages.js";
import type { ChannelAttachmentType, ChannelMessage } from "./types.js";

export type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function attachmentTypeFromMediaType(mediaType: string | undefined): ChannelAttachmentType {
  if (mediaType?.startsWith("image/") === true) return "image";

  if (mediaType?.startsWith("audio/") === true) return "audio";

  if (mediaType?.startsWith("video/") === true) return "video";

  return "file";
}

export function isValidBase64(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;

  const paddingStart = value.indexOf("=");

  if (paddingStart === -1) return value.length % 4 !== 1;

  const paddingLength = value.length - paddingStart;
  const expectedPadding = (4 - (paddingStart % 4)) % 4;
  return value.length % 4 === 0 && paddingLength === expectedPadding;
}

export function base64ByteLength(
  value: string,
  options: Readonly<{ allowEmpty?: boolean; maximumBytes?: number }> = {},
): number {
  if (value.length === 0) {
    if (options.allowEmpty === true) return 0;

    throw new TypeError("Channel attachment data must be valid base64");
  }

  if (options.maximumBytes !== undefined) {
    const maximumCharacters = Math.ceil(options.maximumBytes / 3) * 4;

    if (value.length > maximumCharacters) return options.maximumBytes + 1;
  }

  if (!isValidBase64(value)) {
    throw new TypeError("Channel attachment data must be valid base64");
  }

  const paddingStart = value.indexOf("=");

  if (paddingStart === -1) return Math.floor((value.length * 3) / 4);

  const paddingLength = value.length - paddingStart;
  return (value.length / 4) * 3 - paddingLength;
}

export function validateOutboundChannelMessage(
  message: ChannelMessage,
  options: Readonly<{ platformLabel: string; maximumLength: number }>,
): void {
  const { platformLabel, maximumLength } = options;

  if (
    typeof message.text !== "string" ||
    (message.text.length === 0 && message.attachments === undefined)
  ) {
    throw new TypeError(`${platformLabel} message must include text or attachments`);
  }

  if (message.text.length > maximumLength) {
    throw new RangeError(
      `${platformLabel} message text must not exceed ${maximumLength} characters`,
    );
  }

  validateChannelMessage(message);
}

export async function readBoundedResponseBuffer(
  response: Response,
  options: Readonly<{ maximumBytes: number; label: string }>,
): Promise<Buffer> {
  const { maximumBytes, label } = options;
  const contentLength = response.headers.get("content-length");

  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new RangeError(`${label} must not exceed ${maximumBytes} bytes`);
  }

  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    if (totalBytes + value.byteLength > maximumBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new RangeError(`${label} must not exceed ${maximumBytes} bytes`);
    }

    chunks.push(value);
    totalBytes += value.byteLength;
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function reportChannelError<Context>(
  onError: ((error: unknown, context: Context) => void | Promise<void>) | undefined,
  error: unknown,
  context: Context,
): Promise<void> {
  try {
    await onError?.(error, context);
  } catch {}
}

export async function reportErrorSafely(
  onError: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): Promise<void> {
  try {
    await onError?.(error);
  } catch {}
}

export class BoundedSet<Value> {
  private readonly values = new Set<Value>();

  constructor(private readonly maximumSize: number) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize <= 0) {
      throw new TypeError("BoundedSet maximum size must be a positive integer");
    }
  }

  get size(): number {
    return this.values.size;
  }

  has(value: Value): boolean {
    return this.values.has(value);
  }

  add(value: Value): void {
    this.values.add(value);

    if (this.values.size <= this.maximumSize) return;

    const oldest = this.values.values().next().value;

    if (oldest !== undefined) this.values.delete(oldest);
  }

  delete(value: Value): boolean {
    return this.values.delete(value);
  }

  clear(): void {
    this.values.clear();
  }
}

export class BoundedMap<Key, Value> {
  private readonly entries = new Map<Key, Value>();

  constructor(private readonly maximumSize: number) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize <= 0) {
      throw new TypeError("BoundedMap maximum size must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: Key): Value | undefined {
    return this.entries.get(key);
  }

  has(key: Key): boolean {
    return this.entries.has(key);
  }

  set(key: Key, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);

    if (this.entries.size <= this.maximumSize) return;

    const oldest = this.entries.keys().next().value;

    if (oldest !== undefined) this.entries.delete(oldest);
  }

  delete(key: Key): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
