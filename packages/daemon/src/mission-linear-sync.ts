/** Single-flight, bounded remote synchronization. SQLite intents precede every network write. */
import { createHash } from "node:crypto";
import type { LinearStateMapping, MissionLinearSync, ProjectTrackingConfig, TrackingJson } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { workflowStates } from "./linear-workflow.ts";
import type { MissionStore } from "./missions.ts";
import type { ProjectStore } from "./projects.ts";
import {
	SourceConfigurationError,
	type SourceMcpClient,
	SourceRateLimited,
	SourceSignInRequired,
	SourceToolError,
} from "./source-mcp.ts";
import { LookupFormatChanged } from "./tracking-lookup.ts";

type Linked = NonNullable<ReturnType<MissionStore["linearSyncResource"]>>;
type Call = (tool: string, args: Record<string, unknown>) => Promise<TrackingJson>;
type Issue = { id: string; teamId: string; stateId: string; stateName: string; type: string };
// get_issue rejects unknown field selections. Identifier is encoded in id or the canonical URL;
// status is verified against the team's workflow rather than requesting the unsupported statusId.
const FIELDS = ["id", "uuid", "url", "teamId", "status", "statusType"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Failure = NonNullable<MissionLinearSync["failure"]>;
class SyncProblem extends Error {
	readonly category: Failure["category"];
	constructor(message: string, category: Failure["category"] = "invalid_response") {
		super(message);
		this.category = category;
	}
}
class StaleSync extends Error {}
function failureCategory(error: unknown, stage: Failure["stage"]): Failure["category"] {
	if (error instanceof SyncProblem) return error.category;
	if (error instanceof SourceSignInRequired) return "sign_in";
	if (error instanceof SourceConfigurationError) return "configuration";
	if (error instanceof SourceRateLimited) return "rate_limited";
	if (error instanceof SourceToolError)
		return error.category === "tool_error" ? (stage === "write" ? "write_failed" : "remote_error") : error.category;
	if (error instanceof LookupFormatChanged) return "invalid_response";
	return ["issue", "states", "write", "confirm", "cancellation"].includes(stage) ? "transport" : "unknown";
}

const FAILURE_ADVICE: Record<Failure["category"], string> = {
	sign_in: "Sign in to Linear in Settings, then retry synchronization.",
	access_denied: "Linear denied access. Check ticket and team permissions, then retry synchronization.",
	not_found: "The linked Linear ticket was not found. Review its link and access, then retry.",
	configuration: "Review the Linear integration and Project settings, then retry synchronization.",
	transport:
		"Linear request failed or timed out. Check the connection, then retry synchronization. Unconfirmed writes are reconciled first.",
	rate_limited: "Linear is limiting requests. Synchronization will retry after the backoff.",
	invalid_response: "Linear returned an invalid response. Retry synchronization or review the integration.",
	write_failed: "Linear couldn't confirm the status update. Review the ticket and status mapping, then retry.",
	remote_error: "Linear couldn't read the ticket or workflow. Review ticket access and retry synchronization.",
	unknown: "Couldn't complete Linear synchronization. Review the ticket and retry.",
};
function object(value: TrackingJson): Record<string, TrackingJson> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new SyncProblem("Linear returned an invalid issue. Check access and retry.");
	return value;
}
function string(value: TrackingJson | undefined): string {
	if (typeof value !== "string" || !value.trim() || value.length > 200)
		throw new SyncProblem("Linear returned incomplete issue identity or status. Check access and retry.");
	return value;
}
function configKey(config: ProjectTrackingConfig | undefined): string {
	return createHash("sha256")
		.update(JSON.stringify(config?.linearStateMappings ?? {}))
		.digest("hex");
}

export class MissionLinearSyncService {
	private timer?: ReturnType<typeof setTimeout>;
	private run?: { controller: AbortController; promise: Promise<void> };
	private stopped = false;
	private cursor = "";
	private unsubscribe?: () => void;
	private projectUnsubscribe?: () => void;
	private dirty = false;
	private retryAt?: number;
	private readonly busy = new Set<string>();
	private guardRun?: { controller: AbortController; promise: Promise<boolean | undefined> };
	private publishing = false;
	private readonly store: MissionStore;
	private readonly projects: ProjectStore;
	private readonly mcp: SourceMcpClient;
	constructor(store: MissionStore, projects: ProjectStore, mcp: SourceMcpClient) {
		this.store = store;
		this.projects = projects;
		this.mcp = mcp;
	}

	start(): void {
		this.unsubscribe ??= this.store.onLinearSyncChange(() => this.wake());
		this.projectUnsubscribe ??= this.projects.onChange(() => this.wake());
		this.wake();
	}
	private wake(): void {
		if (this.stopped || this.publishing) return;
		if (this.run) {
			this.dirty = true;
			return;
		}
		clearTimeout(this.timer);
		this.schedule(250);
	}
	private schedule(delay: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const controller = new AbortController();
			const deadline = setTimeout(() => controller.abort(), 90_000);
			this.dirty = false;
			const promise = this.poll(controller.signal)
				.catch(() => {})
				.finally(() => {
					clearTimeout(deadline);
					this.run = undefined;
					// Coalesce local edits, but never spin in response to our own observation writes.
					const retryDelay = this.retryAt ? Math.max(5_000, this.retryAt - Date.now()) : 300_000;
					this.schedule(this.dirty ? 5_000 : Math.min(300_000, retryDelay));
				});
			this.run = { controller, promise };
		}, delay);
		this.timer.unref();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe?.();
		this.projectUnsubscribe?.();
		clearTimeout(this.timer);
		this.run?.controller.abort();
		this.guardRun?.controller.abort();
		await this.run?.promise;
		await this.guardRun?.promise;
	}

	/** Public for offline fixtures. At most 25 tickets, sequential MCP calls, 90s service deadline. */
	async poll(signal: AbortSignal): Promise<void> {
		this.retryAt = undefined;
		let links = this.store.linearSyncBatch(this.cursor);
		if (!links.length) links = this.store.linearSyncBatch();
		for (const link of links) {
			signal.throwIfAborted();
			const current = this.store.linearSyncResource(link.resource.id);
			if (current) await this.synchronize(current, signal);
			const retryAt = this.store.linearSyncRecord(link.resource.id)?.status.retryAt;
			if (retryAt && retryAt > Date.now()) this.retryAt = Math.min(this.retryAt ?? retryAt, retryAt);
			this.cursor = link.resource.id;
		}
	}

	private current(link: Linked, config: string, signal: AbortSignal): void {
		signal.throwIfAborted();
		if (
			this.stopped ||
			this.store.linearSyncResource(link.resource.id)?.record.version !== link.record.version ||
			configKey(this.projects.get(link.projectId)?.tracking) !== config
		)
			throw new StaleSync();
	}
	private save(link: Linked): void {
		this.publishing = true;
		try {
			if (!this.store.saveLinearSync(link.resource.id, link.record.version, link.record)) throw new StaleSync();
		} catch (error) {
			if (error instanceof Conflict) {
				// Do not keep an unbound duplicate UUID in the failure record either.
				delete link.record.status.issueId;
				throw new SyncProblem(
					"This Linear issue already has a verified managing link. Remove the duplicate manager, then retry.",
					"configuration",
				);
			}
			throw error;
		} finally {
			this.publishing = false;
		}
	}
	private pause(link: Linked, reason: string): void {
		link.record.paused = reason;
		link.record.status = { ...link.record.status, state: "paused", reason, updatedAt: Date.now() };
		delete link.record.status.error;
		delete link.record.status.failure;
		delete link.record.status.retryAt;
		delete link.record.intent;
		this.save(link);
	}

	/** Resolve by human identifier once; thereafter only immutable UUID, always the actual team. */
	private async observe(
		link: Linked,
		call: Call,
	): Promise<{ issue: Issue; mapping: LinearStateMapping | undefined; states: ReturnType<typeof workflowStates> }> {
		const response = await call("issue", {
			id: link.record.status.issueId ?? link.resource.externalId,
			fields: FIELDS,
		});
		if (response === null)
			throw new SyncProblem(
				"The linked Linear ticket was not found. Review its link and access, then retry.",
				"not_found",
			);
		const raw = object(response);
		const id = string(raw.uuid ?? raw.id).toLowerCase();
		if (!UUID.test(id))
			throw new SyncProblem("Linear did not return an immutable issue UUID. Refresh the link and retry.");
		if (link.record.status.issueId && id !== link.record.status.issueId)
			throw new SyncProblem("The linked Linear issue identity changed. Review the link before resuming.");
		const identifier = raw.identifier ?? (typeof raw.id === "string" && !UUID.test(raw.id) ? raw.id : undefined);
		if (!link.record.status.issueId) {
			let key: string | undefined;
			try {
				const url = new URL(stringUrl(raw.url));
				const match = url.pathname.match(/^\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/);
				if (url.protocol === "https:" && url.hostname === "linear.app" && match)
					key = `${match[1]!.toLowerCase()}/${match[2]!.toUpperCase()}`;
			} catch {}
			if ((identifier !== undefined && identifier !== link.resource.externalId) || key !== link.resource.linearKey)
				throw new SyncProblem(
					"The Linear link no longer matches this issue. Review its workspace and identifier before retrying.",
				);
		}
		const teamId = string(raw.teamId);
		const states = workflowStates(await call("states", { team: teamId }));
		const status =
			raw.status && typeof raw.status === "object" && !Array.isArray(raw.status) ? raw.status : undefined;
		const stateId = raw.statusId ?? status?.id;
		const candidates = stateId
			? states.filter((s) => s.id === stateId)
			: states.filter((s) => s.name === raw.status || s.id === raw.status);
		if (candidates.length !== 1 || (raw.statusType !== undefined && candidates[0]!.type !== raw.statusType))
			throw new SyncProblem(
				"Linear status could not be verified against the issue's team. Review Project settings and retry.",
			);
		const state = candidates[0]!;
		const mapping = this.projects.get(link.projectId)?.tracking?.linearStateMappings?.[teamId];
		// Validate configured terminal guards even when no outbound target is pending.
		for (const [slot, type] of [
			["deployed", "completed"],
			["canceled", "canceled"],
			["duplicated", "duplicate"],
		] as const) {
			if (mapping?.[slot] && !states.some((s) => s.id === mapping[slot]!.id && s.type === type))
				throw new SyncProblem(
					`Choose a valid ${slot} state for the issue's actual team in Project settings, then retry.`,
					"configuration",
				);
		}
		return {
			issue: { id, teamId, stateId: state.id, stateName: state.name, type: state.type },
			mapping,
			states,
		};
	}

	private terminal(issue: Issue, mapping: LinearStateMapping | undefined): string | undefined {
		if (issue.type === "canceled" || mapping?.canceled?.id === issue.stateId) return "canceled";
		if (issue.type === "duplicate" || mapping?.duplicated?.id === issue.stateId) return "duplicated";
		if (mapping?.deployed?.id === issue.stateId) return "deployed";
	}

	private synced(link: Linked, issue: Issue): void {
		const record = link.record;
		record.lastObservationAt = Date.now();
		record.status = {
			...record.status,
			state: "synced",
			observedStateId: issue.stateId,
			observedStateName: issue.stateName,
			updatedAt: Date.now(),
		};
		delete record.status.error;
		delete record.status.failure;
		delete record.status.retryAt;
		delete record.status.reason;
		record.attempts = 0;
		delete record.intent;
		this.save(link);
	}

	private async synchronize(link: Linked, signal: AbortSignal, readOnly = false): Promise<boolean | undefined> {
		if (this.busy.size) return false;
		this.busy.add(link.resource.id);
		const initialAttempts = link.record.attempts;
		const config = configKey(this.projects.get(link.projectId)?.tracking);
		let stage: Failure["stage"] = "prepare";
		const call: Call = async (tool, args) => {
			if (stage !== "confirm" && stage !== "cancellation")
				stage = tool === "startIssue" ? "write" : tool === "states" ? "states" : "issue";
			this.current(link, config, signal);
			const value = await this.mcp.call("linear", tool, args, signal);
			this.current(link, config, signal);
			return value;
		};
		try {
			const record = link.record;
			if (record.contributors.length > 1000)
				throw new SyncProblem(
					"This ticket has more than 1,000 contributing tasks. Reduce its contribution scope before retrying synchronization.",
					"configuration",
				);
			if (record.status.retryAt && record.status.retryAt > Date.now()) return;
			const { issue, mapping, states } = await this.observe(link, call);
			record.lastObservationAt = Date.now();
			stage = "configuration";
			const terminal = this.terminal(issue, mapping);
			const previous = { ...record.status };
			record.status = {
				...record.status,
				issueId: issue.id,
				teamId: issue.teamId,
				observedStateId: issue.stateId,
				observedStateName: issue.stateName,
				updatedAt: Date.now(),
			};
			if (terminal) {
				record.status.state = "terminal";
				record.status.reason = terminal;
				delete record.intent;
				delete record.status.target;
				if (terminal !== "deployed") {
					stage = "cancellation";
					await this.cancelTasks(link, config, signal, call);
				}
				// Observing terminal state alone does not complete required peer/task reconciliation.
				delete link.record.status.error;
				delete link.record.status.failure;
				delete link.record.status.retryAt;
				link.record.attempts = 0;
				this.save(link);
				return;
			}
			if (!record.acceptBaseline && previous.teamId && previous.teamId !== issue.teamId) {
				this.pause(
					link,
					"The Linear issue moved teams. Review its new team's mappings, then resume synchronization.",
				);
				return;
			}
			const expectedWrite = record.intent?.stateId;
			if (
				!record.acceptBaseline &&
				previous.observedStateId &&
				previous.observedStateId !== issue.stateId &&
				expectedWrite !== issue.stateId
			) {
				this.pause(
					link,
					"The Linear status changed outside synchronization. Review the ticket, then resume synchronization.",
				);
				return;
			}
			if (record.paused || record.status.state === "paused") {
				record.status.state = "paused";
				record.status.reason = record.paused ?? record.status.reason;
				delete record.intent;
				delete record.status.error;
				delete record.status.failure;
				delete record.status.retryAt;
				record.attempts = 0;
				this.save(link);
				return;
			}
			if (previous.state === "terminal" && !record.acceptBaseline) {
				this.pause(
					link,
					"The terminal Linear ticket was reopened. Review its contributing tasks, then resume synchronization.",
				);
				return;
			}
			delete record.acceptBaseline;
			const target = record.intent && mapping?.[record.intent.target];
			if (
				readOnly &&
				(!mapping?.merged || !states.some((s) => s.id === mapping.merged!.id && s.type === "completed"))
			)
				throw new SyncProblem(
					"Choose a valid Merged state for the issue's actual team in Project settings before using a closing directive.",
					"configuration",
				);
			if (readOnly && issue.type === "completed") return false;
			if (
				record.intent &&
				(!target ||
					!states.some(
						(s) =>
							s.id === target.id && s.type === (record.intent!.target === "merged" ? "completed" : "started"),
					))
			)
				throw new SyncProblem(
					`Choose a valid ${record.intent.target} state for the issue's actual team in Project settings, then retry.`,
					"configuration",
				);
			if (record.intent && target && issue.stateId === target.id) {
				this.synced(link, issue);
				return readOnly ? true : undefined;
			}
			if (readOnly && record.intent) {
				// A fresh read verifies PR policy, not an outstanding write. Retain that write's
				// warning and retry budget until mission reconciliation actually succeeds.
				this.save(link);
				return record.status.state !== "error";
			}
			if (!record.intent || !target || readOnly) {
				if (record.status.state === "error") record.status.state = record.intent ? "pending" : "idle";
				delete record.status.error;
				delete record.status.failure;
				delete record.status.retryAt;
				record.attempts = 0;
				this.save(link);
				return true;
			}
			if (issue.type === "completed") {
				this.pause(
					link,
					"Linear is already completed in a different state. Review the ticket, then resume only after choosing the intended status.",
				);
				return;
			}
			if (record.intent.config && record.intent.config !== config) {
				this.pause(
					link,
					"Linear mappings changed during an unfinished write. Review Project settings, then resume synchronization.",
				);
				return;
			}
			if (record.attempts >= 5 && record.status.error) {
				// Continue observing for reconciliation/cancellation without replacing the actual
				// failing stage and category with generic retry-budget advice.
				this.save(link);
				return;
			}
			if (record.attempts >= 5)
				throw new SyncProblem(
					"Automatic Linear updates stopped after five attempts. Check the ticket and connection, then retry synchronization.",
					"write_failed",
				);
			stage = "prepare";
			record.intent.stateId = target.id;
			record.intent.config = config;
			record.status.state = "pending";
			record.attempts += 1;
			this.save(link);
			await this.store.durable();
			this.current(link, config, signal);
			// Linear has no conditional update. Minimize the unavoidable read/write race and do not
			// replay if another actor changed the remote state or actual team during preparation.
			const latest = await this.observe(link, call);
			if (latest.issue.teamId === issue.teamId && latest.issue.stateId === target.id) {
				this.synced(link, latest.issue);
				return;
			}
			if (latest.issue.teamId !== issue.teamId || latest.issue.stateId !== issue.stateId) {
				this.pause(
					link,
					"Linear changed while preparing an update. Review the ticket, then resume synchronization.",
				);
				return;
			}
			await call("startIssue", { id: issue.id, state: target.id });
			// A successful RPC is not proof that the new state was applied. Confirmation also repairs
			// a crash after the write on the next poll, without issuing a duplicate update.
			stage = "confirm";
			const confirmed = await this.observe(link, call);
			if (confirmed.issue.stateId !== target.id || confirmed.issue.teamId !== issue.teamId)
				throw new SyncProblem(
					"Linear did not confirm the requested status. Check the ticket and retry.",
					"write_failed",
				);
			this.synced(link, confirmed.issue);
		} catch (error) {
			if (error instanceof StaleSync || this.stopped) return;
			const record = link.record;
			const category = failureCategory(error, stage);
			record.lastFailureAt = Date.now();
			record.attempts = Math.min(5, Math.max(initialAttempts + 1, record.attempts));
			record.status = {
				...record.status,
				state: record.paused ? "paused" : "error",
				updatedAt: Date.now(),
				failure: { stage, category },
				error: error instanceof SyncProblem ? error.message : FAILURE_ADVICE[category],
			};
			if (record.attempts < 5)
				record.status.retryAt =
					Date.now() +
					Math.max(
						error instanceof SourceRateLimited ? error.retryAfterMs : 0,
						Math.min(300_000, 5_000 * 2 ** record.attempts),
					);
			else delete record.status.retryAt;
			try {
				this.save(link);
			} catch {
				/* A newly detached or duplicate manager cannot gain write authority. */
			}
		} finally {
			this.busy.delete(link.resource.id);
		}
	}

	private async cancelTasks(link: Linked, config: string, signal: AbortSignal, call: Call): Promise<void> {
		const peerIds = this.store.linearCancellationPeers(link.resource.id);
		if (peerIds.length > 25)
			throw new SyncProblem(
				"Too many shared ticket links to verify safely. Review the contributing tasks and retry.",
				"configuration",
			);
		const peers = new Map<string, { version: string; inactive: boolean }>();
		for (const id of peerIds) {
			const peer = this.store.linearSyncResource(id);
			if (!peer) throw new StaleSync();
			const observation = await this.observe(peer, call);
			if (this.store.linearSyncRecord(id)?.version !== peer.record.version) throw new StaleSync();
			if (!peer.record.status.issueId) {
				peer.record.status.issueId = observation.issue.id;
				peer.record.status.teamId = observation.issue.teamId;
				this.save(peer);
			}
			peers.set(id, {
				version: peer.record.version,
				inactive: !!this.terminal(observation.issue, observation.mapping) || observation.issue.type === "completed",
			});
		}
		// Recheck the canceled ticket after peer lookups, not just its cached terminal marker.
		const latest = await this.observe(link, call);
		if (!["canceled", "duplicated"].includes(this.terminal(latest.issue, latest.mapping) ?? ""))
			throw new StaleSync();
		this.current(link, config, signal);
		// Publish the verified terminal observation only after all remote prerequisites succeeded,
		// immediately before the synchronous task policy. Failed peer reads retain the warning.
		this.save(link);
		if (!this.store.dropCanceledLinearTasks(link.resource.id, link.record.version, peers)) throw new StaleSync();
		// Dropping contributors may change our own version synchronously. Retain that exact version
		// across the durability await so unrelated scope edits still fence completion.
		const current = this.store.linearSyncResource(link.resource.id);
		if (!current) throw new StaleSync();
		link.record = current.record;
		await this.store.durable();
		this.current(link, config, signal);
	}

	/** Finality itself is checked by the PR policy; this supplies a fresh fail-closed lifecycle guard. */
	async closingEligibility(missionId: string, resourceId: string): Promise<{ allowed: boolean; reason?: string }> {
		const link = this.store.linearSyncResource(resourceId);
		if (!link || link.missionId !== missionId || this.busy.size)
			return { allowed: false, reason: "Linear synchronization is unavailable or busy. Retry after it finishes." };
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 30_000);
		try {
			const promise = this.synchronize(link, controller.signal, true);
			this.guardRun = { controller, promise };
			const verified = await promise;
			await this.store.durable();
			const current = this.store.linearSyncResource(resourceId);
			const status = current?.record.status;
			const allowed =
				verified === true &&
				!controller.signal.aborted &&
				current?.record.version === link.record.version &&
				!!status?.issueId &&
				!!status.observedStateId &&
				status.updatedAt >= Date.now() - 30_000 &&
				["idle", "synced", "pending"].includes(status.state);
			return {
				allowed,
				...(!allowed
					? {
							reason:
								status?.error ??
								status?.reason ??
								"Review and resume Linear synchronization before adding a closing directive.",
						}
					: {}),
			};
		} finally {
			clearTimeout(deadline);
			this.guardRun = undefined;
		}
	}
}

function stringUrl(value: TrackingJson | undefined): string {
	if (typeof value !== "string" || value.length > 4000) throw new SyncProblem("Invalid Linear URL.");
	return value;
}
