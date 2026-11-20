/**
 * The screen agent's wire contract (apps/day/screen-agent/day-screen-agent.md). A screen agent chat asks
 * the one Day window it is bound to for a snapshot, a query, actions or a picture. The daemon keeps
 * each request waiting until that window answers or its deadline passes. Types only.
 */
import type { StagedAttachmentRef } from "../sources/transfers.ts";

/** One step of an act request, as UI SDK names it: a ref, label, item or kind; an action; its arguments. */
export interface ScreenStep {
	ref: string;
	action: string;
	args?: unknown[];
}

/** What a screen agent asks of its window. */
export type ScreenOperation =
	| { op: "snapshot" }
	| { op: "query"; text?: string; within?: string; kind?: string }
	| { op: "act"; steps: ScreenStep[] }
	| { op: "screenshot" };

/** One waiting request, as the bound window reads it. `deadline` is epoch milliseconds. */
export interface ScreenRequest {
	id: string;
	sessionId: string;
	windowId: string;
	operation: ScreenOperation;
	deadline: number;
}

/** The window's answer to one request. `error` is a sentence the agent reads. */
export type ScreenAnswer = { ok: true; value: unknown } | { ok: false; error: string };

/** A picture the window took of itself, saved in the attachment store. */
export interface ScreenPicture {
	attachment: StagedAttachmentRef;
	width: number;
	height: number;
	mimeType: "image/png";
}

/** What the daemon gives the kernel for a screenshot: the picture and its PNG bytes as base64. */
export interface ScreenPictureData {
	picture: ScreenPicture;
	data: string;
}

/** Which window answers a screen agent chat. Day sets it when the bar opens or restores the chat. */
export interface ScreenBinding {
	windowId: string;
	sessionId: string;
}
