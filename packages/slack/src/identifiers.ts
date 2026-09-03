export function isSlackId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{1,}$/.test(value);
}

export function validateSlackId(value: string, label: string): void {
  if (!isSlackId(value)) throw new TypeError(`${label} must be a Slack ID`);
}

export function isSlackTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{10,}\.\d+$/.test(value);
}

export function validateSlackTimestamp(value: string, label: string): void {
  if (!isSlackTimestamp(value)) throw new TypeError(`${label} must be a Slack timestamp`);
}

const SLACK_DOWNLOAD_DOMAINS = ["slack.com", "slack-files.com", "slack-gov.com"];

/** True for HTTPS URLs hosted on Slack-controlled file domains. */
export function isSlackDownloadUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return SLACK_DOWNLOAD_DOMAINS.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}
