/** Small, commit-consistent run/inbox monitor. Never hydrates transcript history. */
import type { Context } from "@earendil-works/chord";
import { execFile } from "node:child_process";
import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import {
	type AgentEventStream,
	type ConversationId,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type LiveState,
	type Session,
	type SnapshotEvent,
} from "@earendil-works/pi-durable";

export type ActivityStream = Pick<AgentEventStream, "snapshot" | "start"> & { stop(): Promise<void> };

/** Only exact, live SDK-owned transport PIDs with no outstanding requests are infrastructure. */
export class InfrastructureChildren {
	private readonly transports = new Map<ReturnType<McpTransportFactory>, Set<string | number>>();

	track(transport: ReturnType<McpTransportFactory>): void {
		const pending = new Set<string | number>();
		this.transports.set(transport, pending);
		const stopMessages = transport.onMessage((message) => {
			if ("id" in message && message.id !== null && !("method" in message)) pending.delete(message.id);
		});
		const send = transport.send.bind(transport);
		transport.send = async (message) => {
			const id = "id" in message && "method" in message ? message.id : undefined;
			if (id !== undefined) pending.add(id);
			try {
				await send(message);
			} catch (error) {
				if (id !== undefined) pending.delete(id);
				throw error;
			}
		};
		const stopClose = transport.onClose(() => {
			this.transports.delete(transport);
			stopMessages();
			stopClose();
		});
	}

	idlePids(): ReadonlySet<number> {
		const pids = new Set<number>();
		for (const [transport, pending] of this.transports) {
			const pid = "pid" in transport ? transport.pid : undefined;
			if (pending.size === 0 && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
		}
		return pids;
	}
}

/** Unknown children and process-list failures protect jobs. Never classify by executable name. */
export function hasUnownedChildren(output: string, infrastructure: ReadonlySet<number>): boolean {
	return output
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.some((value) => {
			const pid = Number(value);
			return !Number.isSafeInteger(pid) || pid <= 0 || !infrastructure.has(pid);
		});
}

function listChildPids(parents: readonly number[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("pgrep", ["-P", parents.join(",")], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
			if (!error) resolve(stdout);
			else if ((error as { code?: unknown }).code === 1) resolve("");
			else reject(error);
		});
	});
}

export async function inspectChildren(
	infrastructure: InfrastructureChildren,
	listChildren: (parents: readonly number[]) => Promise<string> = listChildPids,
): Promise<boolean> {
	try {
		const direct = await listChildren([process.pid]);
		// Read the live allowlist after pgrep completes, so newly active/closed transports are protected.
		const idle = infrastructure.idlePids();
		if (hasUnownedChildren(direct, idle)) return true;
		if (idle.size === 0) return false;
		// Exact root ownership does not establish ownership of descendants. In particular npx/uvx
		// wrappers with untracked server children remain protected; never guess helpers versus jobs.
		const descendants = await listChildren([...idle]);
		if (descendants.trim()) return true;
		return hasUnownedChildren(direct, infrastructure.idlePids());
	} catch {
		return true;
	}
}

function snapshot(live: Readonly<LiveState> | null, inbox: Readonly<InboxState> | null): SnapshotEvent {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		compactions: [],
		agent: {},
		usage: { models: {}, tools: {} },
		...(live?.run ? { run: { inputs: [...live.run.inputs] } } : {}),
		inbox: (inbox?.items ?? []).map(({ id, mode }) => ({ id, mode })),
	};
}

export async function watchActivity(session: Session, id: ConversationId, context: Context): Promise<ActivityStream> {
	let initial!: SnapshotEvent;
	let pending: SnapshotEvent | undefined;
	let last: string;
	let listener: Parameters<ActivityStream["start"]>[0] | undefined;
	let delivery = Promise.resolve();
	let delivering = false;
	let stopped = false;
	let detachCommit = () => {};
	let detachClose = () => {};
	const detach = () => {
		stopped = true;
		pending = undefined;
		detachCommit();
		detachClose();
		context.abortSignal?.removeEventListener("abort", detach);
	};
	const schedule = () => {
		if (!listener || stopped || delivering) return;
		delivering = true;
		delivery = Promise.resolve()
			.then(async () => {
				while (pending && !stopped) {
					const frame = pending;
					pending = undefined;
					await listener!([frame], context);
				}
			})
			.catch((error: unknown) => {
				detach();
				console.warn("pilot: activity listener failed", error);
			})
			.finally(() => {
				delivering = false;
				if (pending && !stopped) schedule();
			});
	};
	try {
		// A read-only transaction on the public Session line makes initial capture and
		// subscription atomic. Separate watchDoc calls could combine different revisions
		// and falsely report idle while queued input starts a run between those calls.
		await session.commit(async (tx) => {
			context.abortSignal?.throwIfAborted();
			initial = snapshot(await tx.doc(LiveDoc, id), await tx.doc(InboxDoc, id));
			last = JSON.stringify(initial);
			// Keep only the small projection, not potentially large tool output or queued content.
			let run = initial.run;
			let queued = initial.inbox;
			detachCommit = session.subscribeCommits((publication) => {
				if (stopped) return;
				let touched = false;
				for (const change of publication.changes) {
					if (change.type !== "document" || change.conversationId !== id || change.record.key !== undefined)
						continue;
					if (change.record.kind === LiveDoc.definition.kind) {
						const live = change.value as Readonly<LiveState> | null;
						run = live?.run ? { inputs: [...live.run.inputs] } : undefined;
						touched = true;
					} else if (change.record.kind === InboxDoc.definition.kind) {
						const inbox = change.value as Readonly<InboxState> | null;
						queued = (inbox?.items ?? []).map(({ id, mode }) => ({ id, mode }));
						touched = true;
					}
				}
				if (!touched) return;
				const frame: SnapshotEvent = { ...initial, ...(run ? { run } : {}), inbox: queued };
				if (!run) delete frame.run;
				const key = JSON.stringify(frame);
				if (key === last) return;
				last = key;
				pending = frame;
				schedule();
			});
			detachClose = session.subscribeClose(detach);
		}, context);
		context.abortSignal?.throwIfAborted();
		context.abortSignal?.addEventListener("abort", detach, { once: true });
	} catch (error) {
		detach();
		throw error;
	}
	return {
		snapshot: initial,
		start(next) {
			if (listener) throw new Error("Activity stream already started");
			listener = next;
			schedule();
		},
		async stop() {
			detach();
			await delivery;
		},
	};
}
