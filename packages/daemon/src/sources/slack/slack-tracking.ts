/** Slack-only tracking work on the shared source scheduler: inspector reads, adding by link, starts and labels. */
import type {
	Project,
	SlackChannelOption,
	SlackCommonCaseList,
	SlackExcerpt,
	SlackThread,
	TrackedItem,
	TrackedItemList,
	TrackingLookup,
} from "@pilot/protocol";
import { Conflict, ServiceUnavailable } from "../../runtime/contracts/errors.ts";
import type { RuntimeBackground } from "../../runtime/lifecycle/runtime-background.ts";
import { parseSlackMessageLink, SlackFormatChanged } from "./slack-format.ts";
import { type SlackAdder, slackExcerpt, slackThread } from "./slack-source.ts";
import { slackStart, slackStartAllowed } from "./slack-start.ts";
import type { SlackWaitingWatcher } from "./slack-waiting.ts";
import { isConfigured, sourceId } from "../source-kinds.ts";
import {
	abortable,
	logCause,
	type SourcePollContext,
	type SourceScheduler,
	TRACKING_BUSY,
	TRACKING_STOPPED,
} from "../refresh/source-poll.ts";
import { SourceRateLimited, SourceSignInRequired, SourceToolError } from "../source-tool-rules.ts";
import { lookupSlackChannels } from "../tracking/tracking-lookup.ts";

/** A definite refusal before an explicit import entered local item persistence. */
export class SlackImportRefused extends ServiceUnavailable {}

export interface SlackTrackingOptions {
	/** Reads and classifies a Slack message the user pasted. Without it, adding by link is unavailable. */
	adder?: SlackAdder;
	/** Reads waiting messages' threads after each Slack poll and resumes their chats. */
	waiting?: SlackWaitingWatcher;
}

const INSPECT = "slack:inspect";

export class SlackTracking {
	private readonly scheduler: SourceScheduler;
	private readonly adder?: SlackAdder;
	readonly waiting?: SlackWaitingWatcher;
	/** The inspector's latest selection. Only it may hold the inspect slot. */
	private inspected?: { itemId: string; what: "excerpt" | "thread" };
	private inspectGeneration = 0;
	/** Configured Slack channels per project, to hide items of removed channels once. */
	private readonly channels: Map<string, string>;
	/** Close labels last sent to the store per project, so only changed effects reconcile stored messages. */
	private readonly close = new Map<string, string>();
	constructor(scheduler: SourceScheduler, options: SlackTrackingOptions = {}) {
		this.scheduler = scheduler;
		this.adder = options.adder;
		this.waiting = options.waiting;
		this.channels = new Map(
			scheduler.projects
				.list()
				.map((project) => [project.id, JSON.stringify(project.tracking?.slackChannels ?? [])]),
		);
	}

	/** Cancels a poll when the project's Slack admission (channels, mention-only channels, groups) changes. */
	pollAllowed(project: Project): () => boolean {
		const scope = slackPollScope(project);
		return () => {
			try {
				return slackPollScope(this.scheduler.projects.require(project.id)) === scope;
			} catch {
				return false;
			}
		};
	}

	/** After a committed poll: hide items of removed channels, then check replies to waiting messages. */
	async afterCommit(context: SourcePollContext): Promise<void> {
		const { items, projects } = this.scheduler;
		await items.retainSlack(context.project.id, projects.require(context.project.id).tracking?.slackChannels ?? []);
		if (!this.waiting) return;
		context.signal.throwIfAborted();
		context.observe?.({ stage: "waiting_replies", phase: "started" });
		await abortable(this.waiting(context), context.signal);
	}

	projectsChanged(current: Set<string>): void {
		for (const id of this.close.keys()) if (!current.has(id)) this.close.delete(id);
		for (const id of this.channels.keys()) if (!current.has(id)) this.channels.delete(id);
	}

	/** Removing a channel hides its items; adding it back shows them again. Links are kept. */
	retainChannels(): void {
		for (const project of this.scheduler.projects.list()) {
			const channels = project.tracking?.slackChannels ?? [];
			if (this.channels.get(project.id) === JSON.stringify(channels)) continue;
			this.channels.set(project.id, JSON.stringify(channels));
			void this.scheduler.items.retainSlack(project.id, channels).catch((error: unknown) => {
				if (this.channels.get(project.id) === JSON.stringify(channels)) this.channels.delete(project.id);
				console.warn(`pilotd: Slack channel retention failed: ${logCause(error)}`);
			});
		}
	}

	/** Send changed close labels to the store's legacy settings validator. This never changes a message's status. */
	syncLabelEffects(runtime: RuntimeBackground): void {
		const entries = this.scheduler.projects
			.list()
			.map((project) => ({ projectId: project.id, close: closeLabels(project) }))
			.filter((entry) => this.close.get(entry.projectId) !== JSON.stringify(entry.close));
		if (!entries.length) return;
		for (const entry of entries) this.close.set(entry.projectId, JSON.stringify(entry.close));
		void runtime
			.run("label-effects", () => this.scheduler.items.slackLabelEffects(entries))
			.catch((error: unknown) => {
				// Retry with the next settings change.
				for (const entry of entries)
					if (this.close.get(entry.projectId) === JSON.stringify(entry.close)) this.close.delete(entry.projectId);
				console.warn(`pilotd: Slack label effects failed: ${logCause(error)}`);
			});
	}

	async commonCases(projectId: string): Promise<SlackCommonCaseList> {
		const project = this.scheduler.projects.require(projectId);
		const id = sourceId(projectId, "slack"),
			checkpoint = this.scheduler.items.checkpoint(id);
		if (!isConfigured(project, "slack") || (checkpoint && checkpoint.configKey !== this.scheduler.currentKey(id)))
			return { cases: [], windowDays: 30, windowLimit: 200, truncated: false };
		return this.scheduler.items.commonCases(projectId);
	}

	/** Slack messages in triage, of one project or every project, matching every word of a query in their title,
	 * channel or thread text, or the thread of a pasted Slack link. Latest first, done and dismissed included.
	 * Local only: no Slack reads. */
	async search(query: string, projectId: string | undefined, limit: number): Promise<TrackedItemList> {
		const { projects } = this.scheduler;
		const projectIds = (projectId ? [projects.require(projectId)] : projects.list()).map((project) => project.id);
		const link = parseSlackMessageLink(query);
		return this.scheduler.items.searchSlack({
			projectIds,
			query: link ? "" : query.slice(0, 500),
			...(link
				? { externalIds: [...new Set([`${link.channel}/${link.threadTs}`, `${link.channel}/${link.ts}`])] }
				: {}),
			limit,
		});
	}

	/** Slack channels matching a query, or the channels I'm in. Read-only, never stored. */
	channelOptions(query?: string): Promise<TrackingLookup<SlackChannelOption>> {
		return this.scheduler.lookup("slack", (call) => lookupSlackChannels(call, query));
	}

	/** The first message of a Slack item's thread, for the triage inspector. Read on demand, never stored. A newer
	 * request replaces the one in flight, so moving through the list never queues Slack reads. Failures are plain,
	 * logged without content, and leave the source's health alone: the inspector shows them quietly. */
	excerpt(itemId: string): Promise<SlackExcerpt> {
		return this.inspect(itemId, "excerpt", slackExcerpt);
	}
	/** The whole thread of a Slack item, parent first, read like the excerpt and sharing its single slot. */
	thread(itemId: string): Promise<SlackThread> {
		return this.inspect(itemId, "thread", slackThread);
	}
	private async inspect<T>(
		itemId: string,
		what: "excerpt" | "thread",
		read: (context: SourcePollContext, item: TrackedItem) => Promise<T>,
	): Promise<T> {
		const s = this.scheduler;
		if (!s.open()) throw new ServiceUnavailable(TRACKING_STOPPED);
		const previous = s.slot(INSPECT);
		if (
			previous &&
			this.inspected?.itemId === itemId &&
			this.inspected.what === what &&
			!previous.controller.signal.aborted
		)
			return previous.promise as Promise<T>;
		const generation = ++this.inspectGeneration;
		if (previous) {
			previous.controller.abort(new Conflict("Superseded by a newer selection"));
			await previous.promise.catch(() => {});
		}
		const item = await s.items.require(itemId);
		if (generation !== this.inspectGeneration || s.slot(INSPECT))
			throw new Conflict("Superseded by a newer selection");
		if (!s.open()) throw new ServiceUnavailable(TRACKING_STOPPED);
		if (item.kind !== "slack") throw new Conflict(`Only Slack messages have an ${what}`);
		const id = sourceId(item.projectId, "slack"),
			key = s.currentKey(id);
		const checkpoint = s.items.checkpoint(id);
		// A message added by hand can be read before the first sync; it is listed then too.
		if (!key || (item.metadata.manual !== true && (!checkpoint || checkpoint.configKey !== key)))
			throw new Conflict("Sync this project's Slack source first");
		const health = s.health(id);
		if (health?.key === key && health.failures > 0 && health.nextPollAt > Date.now())
			throw new ServiceUnavailable("Slack is unavailable right now");
		if (!s.free()) throw new ServiceUnavailable(TRACKING_BUSY);
		const project = structuredClone(s.projects.require(item.projectId));
		this.inspected = { itemId, what };
		return s.admit(INSPECT, { ms: 30_000, message: `Slack ${what} timed out` }, (signal) =>
			abortable(
				read(
					{
						project,
						config: project.tracking ?? { slackChannels: [] },
						signal,
						call: (tool, args) => s.read("slack", tool, args, signal),
					},
					item,
				),
				signal,
			)
				.then((value) => {
					if (s.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
					return value;
				})
				.catch((error: unknown) => {
					if (error instanceof Conflict) throw error;
					console.warn(`pilotd: Slack ${what} failed for project ${item.projectId}: ${logCause(error)}`);
					throw new ServiceUnavailable(
						error instanceof SourceSignInRequired
							? "Sign in to Slack to read this message"
							: "Couldn't read this message from Slack",
					);
				}),
		);
	}

	/** Adds one Slack message from a pasted link to a project's triage, from any channel the user's Slack account can
	 * read, even when the project does not track channels. Repeated requests for the same message share one read; a
	 * message already in triage is returned as it is, with its local status and links. Provider rate limits also
	 * postpone later reads. */
	add(projectId: string, url: string): Promise<TrackedItem> {
		const s = this.scheduler;
		if (!s.open()) throw new SlackImportRefused(TRACKING_STOPPED);
		const link = parseSlackMessageLink(url);
		if (!link) throw new SlackImportRefused("Paste a link to a Slack message");
		const project = structuredClone(s.projects.require(projectId));
		const id = sourceId(projectId, "slack"),
			key = s.currentKey(id);
		if (!key) throw new SlackImportRefused("Project is unavailable");
		const health = s.health(id);
		if (health?.limited && health.nextPollAt > Date.now())
			throw new SlackImportRefused("Slack is limiting requests. Try importing after the delay.");
		const adder = this.adder;
		if (!adder) throw new SlackImportRefused("Adding Slack messages is unavailable");
		const name = `slack:add:${projectId}/${link.channel}/${link.threadTs}`;
		const existing = s.slot(name);
		if (existing) return existing.promise as Promise<TrackedItem>;
		if (!s.free()) throw new SlackImportRefused(TRACKING_BUSY);
		let saving = false;
		// Below the app's one-minute request timeout, so the app shows pilotd's plain reason.
		return s.admit(name, { ms: 50_000, message: "Adding the message timed out" }, (signal) =>
			abortable(
				(async () => {
					signal.throwIfAborted();
					const input = await adder(
						{
							project,
							config: project.tracking ?? { slackChannels: [] },
							signal,
							call: (tool, args) => s.read("slack", tool, args, signal),
						},
						link,
					);
					signal.throwIfAborted();
					if (s.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
					saving = true;
					await s.items.commit(projectId, "slack", [input]);
					// A message stored earlier from a channel no longer tracked is shown again.
					await s.items.retainSlack(projectId, s.projects.require(projectId).tracking?.slackChannels ?? []);
					return s.items.requireExternal(projectId, "slack", input.externalId);
				})(),
				signal,
			).catch((error: unknown) => {
				if (saving) throw new Error("Couldn't confirm the saved message. Check status; do not retry it.");
				if (error instanceof SlackImportRefused) throw error;
				if (error instanceof Conflict) throw new SlackImportRefused(error.message);
				console.warn(`pilotd: adding a Slack message failed for project ${projectId}: ${logCause(error)}`);
				if (error instanceof SourceSignInRequired)
					throw new SlackImportRefused("Sign in to Slack to add this message");
				if (error instanceof SourceRateLimited) {
					s.failed(id, key, error);
					throw new SlackImportRefused("Slack is limiting requests. Try importing after the delay.");
				}
				if (error instanceof SourceToolError || error instanceof SlackFormatChanged)
					throw new SlackImportRefused(
						"Couldn't read this message from Slack. Check the link and that you can see it in Slack.",
					);
				throw new SlackImportRefused("Couldn't read this message. Nothing was saved. Try again later.");
			}),
		);
	}

	/** Single durable attempt per Slack item, independent of how many chats or missions it starts. */
	start(item: TrackedItem): Promise<void> {
		const s = this.scheduler;
		if (item.kind !== "slack") return Promise.resolve();
		const name = `start:${item.id}`;
		const existing = s.slot(name);
		if (existing) return existing.promise as Promise<void>;
		if (!s.open() || !s.free())
			return s.items.reserveSlackStart(item.id).then(async (reserved) => {
				if (reserved) await s.items.slackStartResult(item.id, "error");
			});
		const id = sourceId(item.projectId, "slack");
		const key = s.currentKey(id) ?? "";
		return s.admit(
			name,
			{ ms: 60_000, message: "Slack start timed out" },
			async (signal) => {
				if (!(await s.items.reserveSlackStart(item.id))) return;
				// Read the durable parent identity, not a stale caller snapshot.
				const current = await s.items.require(item.id);
				let outcome: "reacted" | "skipped" | "error" = "error";
				try {
					signal.throwIfAborted();
					if (!key || (current.metadata.manual !== true && s.items.checkpoint(id)?.configKey !== key))
						throw new Conflict("Sync Slack before starting");
					const health = s.health(id);
					if (health && health.status !== "ok" && health.nextPollAt > Date.now())
						throw new Conflict("Source is backing off");
					const project = structuredClone(s.projects.require(item.projectId));
					outcome = await abortable(
						slackStart(
							{
								project,
								config: project.tracking ?? { slackChannels: [] },
								signal,
								call: (tool, args) => {
									signal.throwIfAborted();
									if (s.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
									return s.write("slack", tool, args, signal);
								},
							},
							current,
						),
						signal,
					);
				} catch {
					/* The chat is already linked. Never expose provider errors or retry this write. */
				}
				await s.items.slackStartResult(item.id, outcome);
			},
			{
				sourceId: id,
				key,
				// Slack's poll key ignores the channel list. Starts must still cancel on removal.
				allowed: () => slackStartAllowed(s.projects.require(item.projectId).tracking?.slackChannels ?? [], item),
			},
		);
	}
}

/** Admission changes cancel in-flight discovery without invalidating existing rows/checkpoints. */
function slackPollScope(project: Project): string {
	return JSON.stringify([
		project.tracking?.slackChannels ?? [],
		project.tracking?.slackMentionOnlyChannels ?? [],
		project.tracking?.slackGroupHandles ?? [],
	]);
}

/** Project labels whose Slack messages stay out of the Inbox. */
export function hiddenLabels(project: Project): string[] {
	return (project.tracking?.slackLabels ?? []).filter((label) => label.effect === "hide").map((label) => label.name);
}
/** Project labels that close their Slack messages. */
function closeLabels(project: Project): string[] {
	return (project.tracking?.slackLabels ?? []).filter((label) => label.effect === "close").map((label) => label.name);
}
