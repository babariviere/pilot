import type { TrackingJson } from "@pilot/protocol";

export interface SlackReactionOwner {
	userId: string;
	channel: string;
	messageTs: string;
}

export function isSlackUserId(value: unknown): value is string {
	return typeof value === "string" && /^[UW][A-Z0-9]{1,39}$/.test(value);
}

export function isSlackChannelId(value: unknown): value is string {
	return typeof value === "string" && /^[CDG][A-Z0-9]{1,199}$/.test(value);
}

export function isSlackTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{1,12}\.\d{6}$/.test(value);
}

/** Authenticated profile/auth.test only, not the message author's identity or reaction users. */
export function slackReactionUser(value: TrackingJson): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.ok === false || value.error) return;
	const id =
		value.user_id ??
		(typeof value.result === "string" ? /^User ID: ([UW][A-Z0-9]{1,39})\s*$/m.exec(value.result)?.[1] : undefined);
	return isSlackUserId(id) ? id : undefined;
}

export function validSlackReactionOwner(value: unknown): value is SlackReactionOwner {
	if (!value || typeof value !== "object") return false;
	const owner = value as SlackReactionOwner;
	return isSlackUserId(owner.userId) && isSlackChannelId(owner.channel) && isSlackTimestamp(owner.messageTs);
}
