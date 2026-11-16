// Unsent setup only. Authentication attempts and credentials never enter the window journal.
import { signal } from "nsh";
export const connectionAdding = signal(false);
export const connectionName = signal("");
export const connectionTarget = signal("");
export const connectionKind = signal("url");
export const connectionBinding = signal("");
/** These setup fields do not accept credentials or shell syntax. Never capture likely secrets. */
export function safeConnectionTarget(kind: string, value: string): boolean {
	if (kind === "command") return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value);
	// Match the native pre-journal subset. Paths can themselves contain API keys.
	return (
		value.length <= 2048 && /^https:\/\/[a-z0-9.-]+\.[a-z0-9.-]+(?:\/|\/mcp\/?|\/api\/mcp|\/v1\/mcp)?$/.test(value)
	);
}
export function savedConnectionDraft(): string {
	return connectionAdding()
		? JSON.stringify({
				name: connectionName(),
				target: safeConnectionTarget(connectionKind(), connectionTarget()) ? connectionTarget() : "",
				kind: connectionKind(),
				binding: connectionBinding(),
			})
		: "";
}
export function restoreConnectionDraft(text: string) {
	connectionAdding.set(false);
	if (!text) return;
	try {
		const d = JSON.parse(text);
		if (
			typeof d.name !== "string" ||
			typeof d.target !== "string" ||
			!["url", "command"].includes(d.kind) ||
			typeof d.binding !== "string"
		)
			return;
		connectionName.set(d.name);
		connectionTarget.set(d.target);
		connectionKind.set(d.kind);
		connectionBinding.set(d.binding);
		connectionAdding.set(true);
	} catch {
		/* Invalid drafts never submit. */
	}
}
