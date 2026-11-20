import { describe, expect, it, vi } from "vitest";
import {
  BoundedMap,
  BoundedSet,
  attachmentTypeFromMediaType,
  base64ByteLength,
  isRecord,
  isValidBase64,
  readBoundedResponseBuffer,
  reportChannelError,
  reportErrorSafely,
  validateOutboundChannelMessage,
} from "../src/adapter.js";

describe("@anvia/channel/adapter helpers", () => {
  it("classifies media types consistently", () => {
    expect(attachmentTypeFromMediaType("image/png")).toBe("image");
    expect(attachmentTypeFromMediaType("audio/ogg")).toBe("audio");
    expect(attachmentTypeFromMediaType("video/mp4")).toBe("video");
    expect(attachmentTypeFromMediaType("application/pdf")).toBe("file");
    expect(attachmentTypeFromMediaType(undefined)).toBe("file");
  });

  it("validates and measures padded and unpadded base64 strings", () => {
    expect(isValidBase64("Zg")).toBe(true);
    expect(isValidBase64("Zg==")).toBe(true);
    expect(isValidBase64("Zm8")).toBe(true);
    expect(isValidBase64("Zm8=")).toBe(true);
    expect(isValidBase64("Zm9v")).toBe(true);
    expect(isValidBase64("")).toBe(false);
    expect(isValidBase64("A=")).toBe(false);

    expect(base64ByteLength("Zg")).toBe(1);
    expect(base64ByteLength("Zg==")).toBe(1);
    expect(base64ByteLength("Zm8")).toBe(2);
    expect(base64ByteLength("Zm8=")).toBe(2);
    expect(base64ByteLength("Zm9v")).toBe(3);
    expect(base64ByteLength("", { allowEmpty: true })).toBe(0);
    expect(() => base64ByteLength("")).toThrow(TypeError);
    expect(base64ByteLength("AAAAAAAA", { maximumBytes: 3 })).toBe(4);
  });

  it("reads bounded response bodies and rejects oversized responses", async () => {
    const ok = await readBoundedResponseBuffer(new Response(new Uint8Array([1, 2, 3])), {
      maximumBytes: 3,
      label: "Test attachment",
    });
    expect([...ok]).toEqual([1, 2, 3]);

    await expect(
      readBoundedResponseBuffer(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "4" } }),
        { maximumBytes: 3, label: "Test attachment" },
      ),
    ).rejects.toThrow("Test attachment must not exceed 3 bytes");

    await expect(
      readBoundedResponseBuffer(new Response(new Uint8Array([1, 2, 3, 4])), {
        maximumBytes: 3,
        label: "Test attachment",
      }),
    ).rejects.toThrow("Test attachment must not exceed 3 bytes");
  });

  it("evicts oldest items in BoundedSet and refreshes recency in BoundedMap", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);

    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10);
    map.set("c", 3);
    expect(map.get("a")).toBe(10);
    expect(map.has("b")).toBe(false);
    expect(map.get("c")).toBe(3);
  });

  it("validates outbound messages and contains error observer failures", async () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);

    expect(() =>
      validateOutboundChannelMessage({ text: "" }, { platformLabel: "Acme", maximumLength: 10 }),
    ).toThrow("Acme message must include text or attachments");
    expect(() =>
      validateOutboundChannelMessage(
        { text: "123456" },
        { platformLabel: "Acme", maximumLength: 5 },
      ),
    ).toThrow("Acme message text must not exceed 5 characters");

    const throwingObserver = vi.fn(() => {
      throw new Error("observer failed");
    });
    await expect(
      reportChannelError(throwingObserver, new Error("boom"), { op: "test" }),
    ).resolves.toBeUndefined();
    await expect(reportErrorSafely(throwingObserver, new Error("boom"))).resolves.toBeUndefined();
  });
});
