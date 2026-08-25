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
