/** Which pi.user entries were automatic input rather than typed by the user, from their submission request IDs. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Cursor, EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { AgentEvent, InputOrigin } from "@pilot/protocol";

const PREFIXES: [string, InputOrigin | "user"][] = [
	["native:user:", "user"],
	["native:jobs.result:", "job"],
	["native:subagent", "subagent"],
	["native:", "extension"],
	["mission-notice:", "mission"],
	["mission:", "mission"],
	["pr-follow-up:", "pullRequest"],
];

/** Undefined means the user's own input. `native:user:` is an extension sending on the user's behalf. */
export function inputOrigin(requestId: string | undefined): InputOrigin | undefined {
	if (requestId === undefined) return undefined;
	const origin = PREFIXES.find(([prefix]) => requestId.startsWith(prefix))?.[1];
	return origin === "user" ? undefined : origin;
}

/**
 * Entry ID to origin for automatic input. Rescans submissions only when an unknown user entry appears, which is at
 * most once per delivered message, and never for assistant or tool entries.
 */
export class InputOrigins {
	readonly #origins = new Map<number, InputOrigin>();
	readonly #known = new Set<number>();
	#scanning?: Promise<void>;
	readonly #storage: Pick<Storage, "scanSubmissions">;
	/** A fork inherits entries placed by its ancestors' submissions. */
	readonly #conversationIds: readonly ConversationId[];
	readonly #context: Context;

	constructor(
		storage: Pick<Storage, "scanSubmissions">,
		conversationIds: ConversationId | readonly ConversationId[],
		context: Context,
	) {
		this.#storage = storage;
		this.#conversationIds = Array.isArray(conversationIds) ? conversationIds : [conversationIds as ConversationId];
		this.#context = context;
	}

	async #scan(): Promise<void> {
		for (const conversationId of this.#conversationIds) {
			let cursor: Cursor | undefined;
			do {
				const page = await this.#storage.scanSubmissions({ conversationId }, 256, cursor, this.#context);
				for (const submission of page.items) {
					if (submission.type !== "input" || submission.entry === undefined) continue;
					const entry = Number(submission.entry);
					this.#known.add(entry);
					const origin = inputOrigin(submission.requestId);
					if (origin) this.#origins.set(entry, origin);
				}
				cursor = page.next;
			} while (cursor !== undefined);
		}
	}

	async #ensure(entries: readonly EntryRecord[]): Promise<void> {
		if (!entries.some((entry) => entry.kind === "pi.user" && !this.#known.has(Number(entry.id)))) return;
		this.#scanning ??= this.#scan().finally(() => {
			this.#scanning = undefined;
		});
		await this.#scanning;
		// Entries without a submission (for example native start messages) are the user's; do not rescan for them.
		for (const entry of entries) if (entry.kind === "pi.user") this.#known.add(Number(entry.id));
	}

	/** Copies of automatic user entries carry `origin`; everything else is returned unchanged. */
	async entries(entries: readonly EntryRecord[]): Promise<EntryRecord[]> {
		await this.#ensure(entries);
		return entries.map((entry) => {
			const origin = entry.kind === "pi.user" ? this.#origins.get(Number(entry.id)) : undefined;
			return origin ? ({ ...entry, origin } as EntryRecord) : entry;
		});
	}

	async events(events: readonly AgentEvent[]): Promise<AgentEvent[]> {
		const users = events.some((event) =>
			event.type === "snapshot"
				? event.entries.some((entry) => entry.kind === "pi.user")
				: event.type === "entry_appended" && event.entry.kind === "pi.user",
		);
		if (!users) return [...events];
		const annotated: AgentEvent[] = [];
		for (const event of events) {
			if (event.type === "snapshot") annotated.push({ ...event, entries: await this.entries(event.entries) });
			else if (event.type === "entry_appended")
				annotated.push({ ...event, entry: (await this.entries([event.entry]))[0]! });
			else annotated.push(event);
		}
		return annotated;
	}
}
