/**
 * Ties each screen agent chat to the one Day window that answers it, and keeps its ui_* requests
 * waiting until that window answers or the deadline passes (docs/technical/day-screen-agent.md).
 * Bindings and requests live in memory only: a restart forgets them, and Day binds again.
 */
import { randomUUID } from "node:crypto";
import type {
	ScreenAnswer,
	ScreenBinding,
	ScreenOperation,
	ScreenPicture,
	ScreenPictureData,
	ScreenRequest,
	StagedAttachmentRef,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";

/** How long a window may take to answer, by operation. An act waits for the screen to settle. */
const SCREEN_DEADLINES: Readonly<Record<ScreenOperation["op"], number>> = {
	snapshot: 5000,
	query: 5000,
	screenshot: 5000,
	act: 20_000,
};
/**
 * Largest picture the kernel gets, as in the design: it goes to the worker as base64 and then to the model.
 * A full Retina window PNG is about 3 to 6 MiB.
 */
const PICTURE_BYTES = 8 * 1024 * 1024;
export const NO_WINDOW =
	"No Day window has this chat open. Open the screen agent with ⌘J in the window you want me to see.";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface Waiting {
	request: ScreenRequest;
	settle(answer: ScreenAnswer): void;
}

interface Dependencies {
	/** Throws NotFound for an unknown chat and Conflict for a chat that is not a screen agent. */
	requireScreenChat(sessionId: string): void;
	/** The PNG bytes of a picture the window uploaded. */
	readPicture(ref: StagedAttachmentRef): Promise<Buffer>;
}

export class ScreenBroker {
	private readonly deps: Dependencies;
	private readonly deadlines: Readonly<Record<ScreenOperation["op"], number>>;
	/** sessionId → windowId. One window per chat. */
	private readonly bindings = new Map<string, string>();
	private readonly waiting = new Map<string, Waiting>();
	private readonly listeners = new Set<(windowId: string) => void>();
	constructor(deps: Dependencies, deadlines?: Partial<Record<ScreenOperation["op"], number>>) {
		this.deps = deps;
		this.deadlines = deadlines ? { ...SCREEN_DEADLINES, ...deadlines } : SCREEN_DEADLINES;
	}

	/** Called with the window's ID each time a request starts waiting for it. A notice only. */
	onRequested(listener: (windowId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	bind(value: unknown): void {
		const b = value as ScreenBinding;
		if (
			!b ||
			typeof b !== "object" ||
			Object.keys(b).sort().join() !== "sessionId,windowId" ||
			typeof b.sessionId !== "string" ||
			!ID.test(b.sessionId) ||
			typeof b.windowId !== "string" ||
			!ID.test(b.windowId)
		)
			throw new Error("A binding is {windowId, sessionId}");
		this.deps.requireScreenChat(b.sessionId);
		// A window shows one screen agent chat at a time.
		for (const [sessionId, windowId] of this.bindings)
			if (windowId === b.windowId && sessionId !== b.sessionId) this.bindings.delete(sessionId);
		this.bindings.set(b.sessionId, b.windowId);
	}

	/** The window closed: its chats lose their binding and its waiting requests fail at once. */
	unbind(windowId: string): void {
		for (const [sessionId, bound] of this.bindings) if (bound === windowId) this.bindings.delete(sessionId);
		for (const w of [...this.waiting.values()])
			if (w.request.windowId === windowId) w.settle({ ok: false, error: NO_WINDOW });
	}

	requests(windowId: string): ScreenRequest[] {
		return [...this.waiting.values()].filter((w) => w.request.windowId === windowId).map((w) => w.request);
	}

	answer(windowId: string, id: string, value: unknown): void {
		const waiting = this.waiting.get(id);
		if (!waiting) throw new NotFound("This request is unknown or expired");
		if (waiting.request.windowId !== windowId) throw new Conflict("This request belongs to another window");
		const a = value as ScreenAnswer;
		if (
			!a ||
			typeof a !== "object" ||
			(a.ok === true
				? Object.keys(a).sort().join() !== "ok,value"
				: a.ok !== false || Object.keys(a).sort().join() !== "error,ok" || typeof a.error !== "string")
		)
			throw new Error("An answer is {ok: true, value} or {ok: false, error}");
		waiting.settle(a);
	}

	/**
	 * Asks the chat's window and waits for its answer. Resolves to the answer's value; for a screenshot,
	 * the picture and its PNG bytes as base64. A refusal, a missing window or the deadline rejects with a
	 * sentence the agent reads.
	 */
	async call(sessionId: string, operation: ScreenOperation, signal?: AbortSignal): Promise<unknown> {
		const windowId = this.bindings.get(sessionId);
		if (!windowId) throw new Error(NO_WINDOW);
		signal?.throwIfAborted();
		const limit = this.deadlines[operation.op];
		const request: ScreenRequest = {
			id: randomUUID(),
			sessionId,
			windowId,
			operation,
			deadline: Date.now() + limit,
		};
		const answer = await new Promise<ScreenAnswer>((resolve) => {
			const timer = setTimeout(
				() =>
					settle({
						ok: false,
						error: `The window did not answer within ${limit / 1000} s. It may be closed or busy.`,
					}),
				limit,
			);
			const abort = () => settle({ ok: false, error: "The request was cancelled" });
			const settle = (a: ScreenAnswer) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.waiting.delete(request.id);
				resolve(a);
			};
			signal?.addEventListener("abort", abort, { once: true });
			this.waiting.set(request.id, { request, settle });
			for (const listener of this.listeners) listener(windowId);
		});
		if (!answer.ok) throw new Error(answer.error);
		return operation.op === "screenshot" ? this.picture(answer.value) : answer.value;
	}

	private async picture(value: unknown): Promise<ScreenPictureData> {
		const p = value as ScreenPicture;
		const ref = p?.attachment;
		if (
			!p ||
			typeof p !== "object" ||
			p.mimeType !== "image/png" ||
			!Number.isSafeInteger(p.width) ||
			!Number.isSafeInteger(p.height) ||
			p.width < 1 ||
			p.height < 1 ||
			!ref ||
			typeof ref.uploadId !== "string" ||
			typeof ref.sha256 !== "string" ||
			!Number.isSafeInteger(ref.bytes)
		)
			throw new Error("The window answered without a picture");
		if (ref.bytes > PICTURE_BYTES)
			throw new Error(
				`The picture has ${ref.bytes} bytes and the limit is ${PICTURE_BYTES}. Make the window smaller and try again.`,
			);
		const bytes = await this.deps.readPicture(ref);
		return {
			picture: {
				attachment: { uploadId: ref.uploadId, sha256: ref.sha256, bytes: ref.bytes },
				width: p.width,
				height: p.height,
				mimeType: "image/png",
			},
			data: bytes.toString("base64"),
		};
	}
}
