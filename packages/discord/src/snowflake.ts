const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n;

export function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return false;
  const snowflake = BigInt(value);
  return snowflake > 0n && snowflake <= MAX_SNOWFLAKE;
}

export function validateDiscordSnowflake(value: string, label: string): void {
  if (!isDiscordSnowflake(value)) throw new TypeError(`${label} must be a snowflake`);
}
