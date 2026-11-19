export function isSlackChannelId(value: unknown): value is string {
	return typeof value === "string" && /^[CDG][A-Z0-9]{1,199}$/.test(value);
}

export function isSlackTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{1,12}\.\d{6}$/.test(value);
}
