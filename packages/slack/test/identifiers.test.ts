import { describe, expect, it } from "vitest";
import { isSlackDownloadUrl } from "../src/identifiers.js";

describe("isSlackDownloadUrl", () => {
  it.each(["slack.com", "slack-files.com", "slack-gov.com"])(
    "accepts HTTPS and rejects other protocols for %s and its subdomains",
    (domain) => {
      for (const hostname of [domain, `files.${domain}`]) {
        expect(isSlackDownloadUrl(`https://${hostname}/file.bin`)).toBe(true);
        for (const protocol of ["http", "ftp", "file", "ws"]) {
          expect(isSlackDownloadUrl(`${protocol}://${hostname}/file.bin`)).toBe(false);
        }
      }
    },
  );

  it.each([
    "https://evil.example/file.bin",
    "https://files.slack.com.evil.example/file.bin",
    "https://evilslack.com/file.bin",
    "https://files.slack.com@evil.example/file.bin",
    "//files.slack.com/file.bin",
    "not a URL",
    "",
    undefined,
    null,
    123,
  ])("rejects invalid or non-Slack URL %s", (url) => {
    expect(isSlackDownloadUrl(url)).toBe(false);
  });
});
