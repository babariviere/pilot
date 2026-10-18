/** Authority validation and durable daemon-owned reconciliation. The Mac only relays immutable envelopes. */
import { randomUUID } from "node:crypto";
import type { MissionAction, MissionContext } from "@pilot/kernel";
import type {
	ArtifactRevision,
	DelegationEvent,
	DelegationGrant,
	DurableOperation,
	MissionDetail,
	MissionTask,
	OperationHost,
	SessionSummary,
	SharedContextBinding,
	SharedContextFreshness,
	SharedContextReference,
	SharedContextSummary,
	SharedEntity,
	SharedExchangeAcknowledgment,
	SharedExchangeBatch,
	SharedMemoryCheckpointManifest,
	SharedMemoryCheckpointPage,
	SharedMemoryMutation,
	SharedMemoryProposal,
	SharedMemoryRead,
	SharedMemoryTreeRead,
	SharedMissionChange,
	SharedMissionProposal,
	SharedMissionRead,
	SharedMissionSnapshot,
	SharedMissionVersions,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionService } from "./mission-service.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, OperationRejected, payloadHash } from "./operation-journal.ts";
import type { ProjectMemoryService } from "./project-memory.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

const installation = (a: OperationHost, b: OperationHost) => a.daemonId === b.daemonId && a.lineageId === b.lineageId;
const wireHost = (host: OperationHost): OperationHost => ({ ...host, hostId: "daemon" });
const digest = (value: unknown) => payloadHash(canonicalJSON(value));
const key = (binding: SharedContextBinding) => digest([binding.bindingId, binding.generation, binding.memoryHome]);
const executionScope = (binding: SharedContextBinding) =>
	`execution:${digest([binding.bindingId, binding.generation, binding.missionHome])}`;
const destinationKey = (peer: OperationHost) => JSON.stringify(["daemon", peer.daemonId, peer.lineageId]);
function validateExport(bytes: string): void {
	if (
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,}/i.test(
			bytes,
		)
	)
		throw new Conflict("Shared export resembles secret material; review/redact curated context before sharing");
}
function fields(value: unknown, allowed: string[], name: string): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((field) => !allowed.includes(field))
	)
		throw new Conflict(`Unknown or malformed ${name} schema; data was not adopted`);
}
function hostFields(host: unknown): void {
	fields(host, ["hostId", "daemonId", "lineageId"], "host identity");
	if (!id(host.hostId) || !id(host.daemonId) || !id(host.lineageId))
		throw new Conflict("Invalid pinned host identity");
}
function projectFields(project: unknown): void {
	fields(project, ["host", "projectId"], "project reference");
	hostFields(project.host);
	if (!id(project.projectId)) throw new Conflict("Invalid qualified project ID");
}
function referenceFields(reference: unknown): void {
	fields(reference, ["host", "sessionId", "artifactId", "revision", "requirement", "digest"], "context reference");
	hostFields(reference.host);
	if (
		!id(reference.sessionId) ||
		!id(reference.artifactId) ||
		!Number.isSafeInteger(reference.revision) ||
		Number(reference.revision) < 1 ||
		!["required", "optional-online"].includes(String(reference.requirement)) ||
		(reference.digest !== undefined && !/^[a-f0-9]{64}$/.test(String(reference.digest)))
	)
		throw new Conflict("Invalid pinned reference metadata");
}
function proposalArgs(action: string, args: unknown): void {
	const shapes: Record<string, string[]> = {
		brief: ["markdown", "expectedRevision"],
		task: ["id", "title", "body", "status", "dependsOn", "decisionIds"],
		decide: ["text", "audience"],
		comment: ["text", "anchor"],
		link: ["url", "title", "taskId", "relationship"],
		attach: ["artifactId", "artifactRevision", "taskId"],
		log: ["text", "kind", "health"],
	};
	if (!shapes[action]) throw new Conflict("Unsupported provisional action");
	fields(args, shapes[action], "proposal arguments");
	if (action === "link" && args.relationship !== undefined && args.relationship !== "reference")
		throw new Conflict("PR ownership needs a separate home-authorized handoff");
}
const id = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/.test(value);
const MAX_SHARED_OBJECT_BYTES = 1024 * 1024;
const MAX_SHARED_FRAGMENTS = Math.ceil(MAX_SHARED_OBJECT_BYTES / 4000);
interface Outgoing {
	operation: DurableOperation;
	transmitted: boolean;
	acknowledged: boolean;
	advance?: { kind: string; cursor: number };
}
interface Replica {
	sequence: number;
	/** Local mission import time, not a memory sync or connectivity timestamp. */
	syncedAt?: number;
	complete: boolean;
	missions: Record<string, SharedMissionSnapshot>;
}
interface Fragment {
	id: string;
	kind: string;
	hash: string;
	index: number;
	count: number;
	text: string;
}
interface Execution {
	needsFactExport?: boolean;
	grant: DelegationGrant;
	operationId: string;
	state: "accepted" | "cancel_requested" | "sealed";
	lastSignature?: string;
	sequence: number;
}
interface PeerState {
	memory?: number;
	mission?: number;
	manifestId?: string;
}
const emptyFreshness = (): SharedContextFreshness => ({
	applied: { memory: 0, mission: 0 },
	complete: false,
	pendingCount: 0,
	conflictCount: 0,
});

export class SharedContextService {
	readonly host: OperationHost;
	private readonly store: MissionStore;
	private readonly memory: ProjectMemoryService;
	private readonly projects: ProjectStore;
	private readonly sessions: SessionManager;
	private readonly listeners = new Set<() => void>();
	private scheduled = false;
	private stopped = false;
	private readonly queues = new Map<string, Promise<unknown>>();
	private pendingSerial = 0;
	private readonly completedFragments = new Map<string, string>();
	private readonly revokingBindings = new Set<string>();
	private readonly contextJobs = new Map<string, Promise<void>>();
	private readonly dirtyContexts = new Set<string>();
	private readonly canonicalMemoryHeads = new Map<string, number>();
	private readonly journalFaults = new Set<string>();
	private readonly subscriptions: (() => void)[];
	constructor(
		host: OperationHost,
		store: MissionStore,
		memory: ProjectMemoryService,
		projects: ProjectStore,
		sessions: SessionManager,
		_missions: MissionService,
	) {
		this.host = host;
		this.store = store;
		this.memory = memory;
		this.projects = projects;
		this.sessions = sessions;
		this.subscriptions = [
			store.onChange(() => this.signal()),
			projects.onChange(() => {
				for (const binding of this.bindings())
					if (
						binding.state === "active" &&
						((installation(binding.executionProject.host, this.host) &&
							!projects.get(binding.executionProject.projectId)) ||
							(installation(binding.memoryHome.host, this.host) && !projects.get(binding.memoryHome.projectId)))
					)
						void this.enroll({ ...binding, state: "revoked" }).catch(() => {});
			}),
			memory.onChange(() => {
				this.signal();
				for (const binding of this.bindings())
					if (
						binding.state === "active" &&
						binding.shareMemory &&
						installation(binding.memoryHome.host, this.host)
					) {
						const count = this.memory.summary(binding.memoryHome.projectId).count;
						if (this.canonicalMemoryHeads.get(binding.bindingId) !== count) {
							this.canonicalMemoryHeads.set(binding.bindingId, count);
							this.scheduleContextChanged(binding);
						}
					}
			}),
			sessions.onChange((session) => {
				try {
					this.observe(session);
				} catch {
					if (this.membership(session.id)) {
						this.journalFaults.add(session.id);
						void sessions.pauseDelegatedJournalFault(session.id).catch(() => {});
					}
				}
			}),
			sessions.onArtifactsChanged((sessionId, artifacts) => {
				const execution = this.membership(sessionId);
				if (!execution || execution.state === "sealed") return;
				for (const artifact of artifacts) {
					const reference = {
						host: this.host,
						sessionId,
						artifactId: artifact.id,
						revision: artifact.revision,
						title: artifact.title,
						kind: artifact.kind,
					};
					const marker = digest([executionScope(this.binding(execution.grant.bindingId, false)), reference]);
					if (this.store.sharingGet("artifact-observed", marker)) continue;
					this.store.sharingTransaction(() => {
						this.recordEvent(execution, "artifact", reference);
						this.store.sharingPut("artifact-observed", marker, true);
					});
				}
				this.signal();
			}),
		];
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private signal(): void {
		if (this.scheduled || this.stopped) return;
		this.scheduled = true;
		queueMicrotask(() => {
			void this.store
				.durable()
				.then(() => {
					this.scheduled = false;
					for (const listener of this.listeners) listener();
				})
				.catch(() => {
					this.scheduled = false;
				});
		});
	}
	private async serial<T>(bindingId: string, work: () => Promise<T>): Promise<T> {
		if (this.pendingSerial >= 64) throw new Conflict("Sharing queue full");
		this.pendingSerial++;
		const prior = this.queues.get(bindingId) ?? Promise.resolve();
		const next = prior.catch(() => {}).then(work);
		this.queues.set(bindingId, next);
		try {
			return await next;
		} finally {
			this.pendingSerial--;
			if (this.queues.get(bindingId) === next) this.queues.delete(bindingId);
		}
	}
	bindings(): SharedContextBinding[] {
		return this.store.sharingList("binding");
	}
	binding(bindingId: string, active = true): SharedContextBinding {
		const binding = this.store.sharingGet<SharedContextBinding>("binding", bindingId);
		if (!binding || (active && binding.state !== "active"))
			throw new Conflict("Shared project is not enrolled or has been revoked");
		return binding;
	}
	async enroll(binding: SharedContextBinding): Promise<void> {
		fields(
			binding,
			[
				"schemaVersion",
				"bindingId",
				"generation",
				"logicalProjectId",
				"memoryHome",
				"missionHome",
				"executionProject",
				"missionIds",
				"shareMemory",
				"state",
			],
			"binding",
		);
		projectFields(binding.memoryHome);
		projectFields(binding.executionProject);
		hostFields(binding.missionHome);
		if (!id(binding.bindingId)) throw new Conflict("Invalid binding identity");
		if (binding.state === "revoked") {
			const previous = this.binding(binding.bindingId, false);
			if (canonicalJSON({ ...previous, state: "revoked" }) !== canonicalJSON(binding))
				throw new Conflict("Revocation must retain the original enrolled scope");
			this.revokingBindings.add(binding.bindingId);
		}
		try {
			await this.serial(binding.bindingId, () => this.enrollReserved(binding));
		} finally {
			if (this.store.sharingGet<SharedContextBinding>("binding", binding.bindingId)?.state !== "revoked")
				this.revokingBindings.delete(binding.bindingId);
		}
	}
	private async enrollReserved(binding: SharedContextBinding): Promise<void> {
		if (
			binding?.schemaVersion !== 1 ||
			!id(binding.bindingId) ||
			!id(binding.logicalProjectId) ||
			!Number.isSafeInteger(binding.generation) ||
			binding.generation < 1 ||
			!Array.isArray(binding.missionIds) ||
			binding.missionIds.length > 128 ||
			binding.missionIds.some((item) => !id(item)) ||
			typeof binding.shareMemory !== "boolean" ||
			!["active", "revoked"].includes(binding.state)
		)
			throw new Conflict("Invalid explicit sharing enrollment");
		for (const peer of [binding.memoryHome?.host, binding.missionHome, binding.executionProject?.host])
			if (!peer || !id(peer.hostId) || !id(peer.daemonId) || !id(peer.lineageId))
				throw new Conflict("Invalid pinned peer identity");
		if (
			![binding.memoryHome.host, binding.missionHome, binding.executionProject.host].some((peer) =>
				installation(peer, this.host),
			)
		)
			throw new Conflict("Enrollment does not include this daemon");
		if (installation(binding.executionProject.host, this.host))
			if (binding.state === "active") this.projects.require(binding.executionProject.projectId);
		if (binding.state === "active" && installation(binding.memoryHome.host, this.host))
			this.projects.require(binding.memoryHome.projectId);
		if (
			binding.state === "active" &&
			binding.shareMemory &&
			installation(binding.memoryHome.host, this.host) &&
			!this.store.sharingGet("binding", binding.bindingId)
		)
			await this.memory.load(binding.memoryHome.projectId);
		if (binding.state === "active" && installation(binding.missionHome, this.host))
			for (const missionId of binding.missionIds) this.store.require(missionId);
		const previous = this.store.sharingGet<SharedContextBinding>("binding", binding.bindingId);
		if (previous && canonicalJSON(previous) !== canonicalJSON(binding)) {
			// Revocation is monotonic. New enrollment never adopts quarantined outboxes/allocations.
			if (
				previous.generation !== binding.generation ||
				binding.state !== "revoked" ||
				canonicalJSON({ ...previous, state: "revoked" }) !== canonicalJSON(binding)
			)
				throw new Conflict("Binding identity/scope is immutable; enroll a new binding after sealing old work");
		}
		if (this.bindings().length >= 128 && !previous) throw new Conflict("Sharing enrollment quota full");
		this.store.sharingTransaction(() => {
			if (binding.state === "active" && installation(binding.missionHome, this.host))
				for (const missionId of binding.missionIds) this.store.shareMission(missionId);
			this.store.sharingPut("binding", binding.bindingId, binding);
		});
		await this.store.durable();
		this.signal();
		if (binding.state === "revoked" && installation(binding.missionHome, this.host))
			for (const grant of this.store.sharedGrants(binding.bindingId))
				if (grant.bindingId === binding.bindingId && grant.state !== "sealed") this.cancel(grant.delegationId);
		if (binding.state === "revoked" && installation(binding.executionProject.host, this.host))
			for (const execution of this.executions(binding.bindingId))
				await this.cancelTarget(binding, execution.grant.delegationId, execution.grant.executionEpoch);
	}
	private peers(binding: SharedContextBinding): OperationHost[] {
		return [binding.memoryHome.host, binding.missionHome, binding.executionProject.host].filter(
			(peer, i, list) => list.findIndex((other) => installation(other, peer)) === i,
		);
	}
	private peerState(binding: SharedContextBinding, peer: OperationHost): PeerState {
		return this.store.sharingGet("peer", digest([binding.bindingId, peer])) ?? {};
	}
	private outbox(bindingId: string, peer?: OperationHost, limit = 4096): Outgoing[] {
		return this.store.sharingOutbox<Outgoing>(bindingId, peer ? destinationKey(peer) : undefined, limit);
	}
	private enqueue(
		binding: SharedContextBinding,
		destination: OperationHost,
		kind: string,
		payload: unknown,
		advance?: Outgoing["advance"],
	): void {
		const bytes = canonicalJSON(payload);
		validateExport(bytes);
		if (Buffer.byteLength(bytes) > MAX_SHARED_OBJECT_BYTES)
			throw new Conflict(
				"Complete shared object exceeds 1-MiB admission quota; mandatory context was not truncated",
			);
		const active = this.store.sharingOutboxCount(binding.bindingId);
		if (active >= 2048) throw new Conflict("Sharing outbox full; retained intents cannot be evicted");
		const emit = (operationKind: string, value: unknown, final = false) => {
			const sequence = (this.store.sharingGet<number>("counter", "producer") ?? 0) + 1;
			this.store.sharingPut("counter", "producer", sequence);
			const payload = canonicalJSON(value);
			const operation: DurableOperation = {
				schemaVersion: 1,
				operationId: randomUUID(),
				producerId: "shared-context",
				sequence,
				origin: wireHost(this.host),
				destination: wireHost(destination),
				kind: operationKind,
				targetId: binding.bindingId,
				payload,
				payloadHash: payloadHash(payload),
				bindingId: binding.bindingId,
				bindingGeneration: binding.generation,
			};
			this.store.sharingOutboxPut(operation, {
				operation,
				transmitted: false,
				acknowledged: false,
				...(final && advance ? { advance } : {}),
			});
		};
		if (Buffer.byteLength(bytes) <= 32 * 1024) emit(kind, payload, true);
		else {
			const count = Math.ceil(bytes.length / 4000),
				fragmentId = randomUUID();
			if (active + count > 4096) throw new Conflict("Sharing retention quota full");
			const hash = payloadHash(bytes);
			for (let index = 0; index < count; index++)
				emit(
					"share-fragment",
					{
						id: fragmentId,
						kind,
						hash,
						index,
						count,
						text: bytes.slice(index * 4000, (index + 1) * 4000),
					},
					index === count - 1,
				);
		}
	}
	private replica(bindingId: string): Replica {
		return this.store.sharingGet("replica", bindingId) ?? { sequence: 0, complete: false, missions: {} };
	}
	private assertBindingActive(bindingId: string): SharedContextBinding {
		if (this.revokingBindings.has(bindingId))
			throw new Conflict("Sharing revocation is pending; new admission is fenced");
		return this.binding(bindingId);
	}
	private async memoryState(
		binding: SharedContextBinding,
	): Promise<import("@pilot/protocol").SharedMemoryReplicaState> {
		if (!binding.shareMemory) return { sequence: 0, complete: true, pendingCount: 0, conflictCount: 0 };
		if (installation(binding.memoryHome.host, this.host))
			return {
				sequence: this.memory.summary(binding.memoryHome.projectId).count,
				complete: true,
				pendingCount: 0,
				conflictCount: 0,
				overlayRevision: 0,
			};
		return this.memory.replicaState(key(binding));
	}
	private async memoryRead(
		binding: SharedContextBinding,
		action: "wake" | "zoom" | "recall",
		args: Record<string, unknown>,
	): Promise<import("@pilot/protocol").SharedMemoryRead> {
		if (!installation(binding.memoryHome.host, this.host)) return this.memory.replicaRead(key(binding), action, args);
		const projectId = binding.memoryHome.projectId;
		const value =
			action === "wake"
				? await this.memory.wake(projectId, Number(args.lines ?? 96))
				: action === "recall"
					? await this.memory.recall(projectId, String(args.regex ?? ""), Number(args.lines ?? 96))
					: await this.memory.zoom(projectId, Number(args.lo), Number(args.hi));
		const state = await this.memoryState(binding);
		if (!Array.isArray(value)) state.sequence = value.count;
		return { state, value, proposals: [] };
	}
	private boundedRead<T>(value: T): T {
		const json = JSON.stringify(value);
		if (Buffer.byteLength(json) > 1024 * 1024)
			throw new Conflict("Shared read exceeds 1 MiB; use a smaller page or shallower tree");
		validateExport(json);
		return value;
	}
	private canonicalMemoryContributions<T extends SharedMemoryRead | SharedMemoryTreeRead>(
		binding: SharedContextBinding,
		read: T,
	): T {
		if (!installation(binding.memoryHome.host, this.host)) return read;
		const proposals = this.store.sharingList<SharedMemoryProposal>(`canonical-memory-proposal:${key(binding)}`);
		if (proposals.length > 256)
			throw new Conflict("Shared memory contribution inventory exceeds 256; reconcile retained proposals");
		return {
			...read,
			proposals,
			state: {
				...read.state,
				pendingCount: proposals.filter((p) => p.state === "pending").length,
				conflictCount: proposals.filter((p) => p.state === "conflict").length,
			},
		};
	}
	/** UI reads have no project/session/path selector. Scope and authority come only from enrollment. */
	async readMemory(
		bindingId: string,
		action: "wake" | "recall" | "zoom",
		args: Record<string, unknown> = {},
	): Promise<SharedMemoryRead> {
		const binding = this.assertBindingActive(bindingId);
		if (!binding.shareMemory) throw new Conflict("Memory is not enrolled in this binding");
		fields(
			args,
			action === "wake" ? ["lines"] : action === "recall" ? ["regex", "lines"] : ["lo", "hi"],
			"shared memory read",
		);
		if (action !== "wake" && action !== "recall" && action !== "zoom")
			throw new Conflict("Unknown shared memory read");
		if (
			args.lines !== undefined &&
			(!Number.isInteger(args.lines) || Number(args.lines) < 1 || Number(args.lines) > 256)
		)
			throw new Conflict("lines must be between 1 and 256");
		if (action === "recall" && (typeof args.regex !== "string" || args.regex.length > 512))
			throw new Conflict("Invalid recall regex");
		if (
			action === "zoom" &&
			(!Number.isSafeInteger(args.lo) ||
				!Number.isSafeInteger(args.hi) ||
				Number(args.lo) < 0 ||
				Number(args.hi) < Number(args.lo))
		)
			throw new Conflict("Invalid shared memory range");
		if (!(await this.memoryState(binding)).complete) throw new Conflict("Shared memory replica is incomplete");
		const read = await this.memoryRead(binding, action, args);
		const result = this.canonicalMemoryContributions(binding, read);
		await this.store.durable();
		this.assertBindingActive(bindingId);
		return this.boundedRead(result);
	}
	async readMemoryTree(
		bindingId: string,
		args: { lo?: number; hi?: number; depth?: number; reveal?: number[] } = {},
	): Promise<SharedMemoryTreeRead> {
		const binding = this.assertBindingActive(bindingId);
		if (!binding.shareMemory) throw new Conflict("Memory is not enrolled in this binding");
		fields(args, ["lo", "hi", "depth", "reveal"], "shared memory tree read");
		if (!(await this.memoryState(binding)).complete) throw new Conflict("Shared memory replica is incomplete");
		const read = installation(binding.memoryHome.host, this.host)
			? {
					value: await this.memory.tree(binding.memoryHome.projectId, args),
					state: await this.memoryState(binding),
					proposals: [],
				}
			: await this.memory.replicaTree(key(binding), args);
		read.state.sequence = read.value.count;
		const result = this.canonicalMemoryContributions(binding, read);
		await this.store.durable();
		this.assertBindingActive(bindingId);
		return this.boundedRead(result);
	}
	private missionReadScope(
		bindingId: string,
		missionId: string,
	): { binding: SharedContextBinding; snapshot: SharedMissionSnapshot; source: "canonical" | "replica" } {
		const binding = this.assertBindingActive(bindingId);
		if (!binding.missionIds.includes(missionId)) throw new NotFound("Mission is outside this binding");
		if (installation(binding.missionHome, this.host))
			return { binding, snapshot: this.store.sharedSnapshot(missionId), source: "canonical" };
		const replica = this.replica(bindingId),
			snapshot = replica.missions[missionId];
		if (!replica.complete || !snapshot) throw new Conflict("Shared mission replica is incomplete");
		return { binding, snapshot: { ...snapshot, sequence: replica.sequence }, source: "replica" };
	}
	async readMission(bindingId: string, missionId: string): Promise<SharedMissionRead> {
		const { binding, snapshot, source } = this.missionReadScope(bindingId, missionId);
		const proposals = this.store
			.sharingList<SharedMissionProposal>(
				source === "canonical" ? `canonical-proposal:${executionScope(binding)}` : `proposal:${bindingId}`,
			)
			.filter((proposal) => proposal.missionId === missionId && proposal.state !== "committed");
		if (proposals.length > 256)
			throw new Conflict("Shared mission contribution inventory exceeds 256; reconcile retained proposals");
		await this.store.durable();
		this.assertBindingActive(bindingId);
		return this.boundedRead({
			bindingId,
			generation: binding.generation,
			authority: binding.missionHome,
			source,
			snapshot,
			proposals,
		});
	}
	async readMissionVersions(
		bindingId: string,
		missionId: string,
		args: { after?: number; limit?: number; sequence?: number } = {},
	): Promise<SharedMissionVersions> {
		fields(args, ["after", "limit", "sequence"], "shared version read");
		const { after = 0, limit = 128, sequence } = args;
		if (
			!Number.isSafeInteger(after) ||
			after < 0 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 128 ||
			(sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))
		)
			throw new Conflict("Invalid shared version page");
		if (after > 0 && sequence === undefined)
			throw new Conflict("Subsequent version pages require their original sequence");
		const binding = this.assertBindingActive(bindingId);
		if (!binding.missionIds.includes(missionId)) throw new NotFound("Mission is outside this binding");
		const canonical = installation(binding.missionHome, this.host);
		const scope = canonical ? undefined : this.missionReadScope(bindingId, missionId);
		const head = canonical ? this.store.sharedHead() : scope!.snapshot.sequence;
		if (sequence !== undefined && sequence !== head)
			throw new Conflict("Shared version sequence changed; restart paging");
		const entities = canonical
			? this.store.sharedVersions(missionId, after, limit + 1)
			: scope!.snapshot.entities
					.map(({ id, kind, revision, definitionRevision, deleted }) => ({
						id,
						kind,
						revision,
						definitionRevision,
						deleted,
					}))
					.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
					.slice(after, after + limit + 1);
		const more = entities.length > limit;
		await this.store.durable();
		this.assertBindingActive(bindingId);
		return this.boundedRead({
			bindingId,
			generation: binding.generation,
			missionId,
			authority: binding.missionHome,
			source: canonical ? "canonical" : "replica",
			sequence: head,
			complete: true,
			entities: entities.slice(0, limit),
			...(more ? { next: after + limit } : {}),
		});
	}
	private async prepare(binding: SharedContextBinding, peer: OperationHost): Promise<void> {
		if (this.outbox(binding.bindingId, peer, 1).length > 0) return;
		if (installation(binding.executionProject.host, this.host) && installation(peer, binding.missionHome)) {
			for (const execution of this.executions(binding.bindingId, "export")) {
				const stream = `events:${executionScope(binding)}:${execution.grant.delegationId}`;
				const cursor = this.store.sharingGet<number>("fact-export-cursor", stream) ?? 0;
				for (const event of this.store.sharingPage<DelegationEvent>(stream, String(cursor).padStart(16, "0"), 16))
					this.store.sharingTransaction(() => {
						this.enqueue(binding, peer, "share-event", event);
						this.store.sharingPut("fact-export-cursor", stream, event.sequence);
						if (event.sequence === execution.sequence) {
							execution.needsFactExport = false;
							this.putExecution(execution);
						}
					});
			}
		}
		if (binding.state !== "active") {
			const marker = digest([binding.bindingId, binding.generation, destinationKey(peer)]);
			if (!this.store.sharingGet("revoke-sent", marker))
				this.store.sharingTransaction(() => {
					this.enqueue(binding, peer, "share-revoke", {});
					this.store.sharingPut("revoke-sent", marker, true);
				});
			return;
		}
		const state = this.peerState(binding, peer);
		if (binding.shareMemory && installation(binding.memoryHome.host, this.host) && !installation(peer, this.host)) {
			if (state.memory === undefined) {
				const exportKey = digest([binding.bindingId, binding.generation, peer]);
				let progress = this.store.sharingGet<{
					manifest: SharedMemoryCheckpointManifest;
					cursor: number;
					exported: boolean;
				}>("memory-export", exportKey);
				if (!progress) {
					progress = {
						manifest: await this.memory.beginCheckpoint(binding.memoryHome.projectId),
						cursor: 0,
						exported: false,
					};
					this.store.sharingPut("memory-export", exportKey, progress);
					await this.store.durable();
				}
				const manifest = progress.manifest;
				for (let pageNumber = 0; !progress.exported && pageNumber < 8; pageNumber++) {
					const page = await this.memory.checkpointPage(
						binding.memoryHome.projectId,
						manifest.checkpointId,
						progress.cursor,
					);
					this.store.sharingTransaction(() => {
						this.enqueue(binding, peer, "share-memory-page", { manifest, page });
						if (page.next === undefined) {
							progress!.exported = true;
							this.enqueue(binding, peer, "share-memory-activate", manifest, {
								kind: "memory",
								cursor: manifest.sequence,
							});
						} else progress!.cursor = page.next;
						this.store.sharingPut("memory-export", exportKey, progress);
					});
				}
			} else {
				const changes = await this.memory.changes(binding.memoryHome.projectId, state.memory, 32);
				if (changes.checkpointRequired)
					throw new Conflict("Memory checkpoint reset requires explicit retained-cursor recovery");
				if (changes.changes.length)
					this.enqueue(binding, peer, "share-memory-changes", changes, {
						kind: "memory",
						cursor: changes.next ?? changes.head,
					});
			}
		}
		if (installation(binding.missionHome, this.host) && !installation(peer, this.host)) {
			if (state.mission === undefined) {
				const snapshots = binding.missionIds.map((missionId) => this.store.sharedSnapshot(missionId));
				const head = this.store.sharedHead();
				this.enqueue(
					binding,
					peer,
					"share-mission-checkpoint",
					{ snapshots, head },
					{ kind: "mission", cursor: head },
				);
			} else if (state.mission < this.store.sharedHead()) {
				const changes = this.store.sharedChanges(state.mission);
				const through = changes.at(-1)?.sequence ?? this.store.sharedHead();
				this.enqueue(
					binding,
					peer,
					"share-mission-changes",
					{
						after: state.mission,
						through,
						changes: changes.filter((change) => binding.missionIds.includes(change.missionId)),
					},
					{ kind: "mission", cursor: through },
				);
			}
		}
		if (installation(binding.executionProject.host, this.host)) {
			if (installation(peer, binding.memoryHome.host) && !installation(binding.memoryHome.host, this.host))
				for (const proposal of await this.memory.replicaProposals(key(binding))) {
					if (
						proposal.state !== "pending" ||
						this.store.sharingGet(`proposal-sent:${executionScope(binding)}`, proposal.mutation.operationId)
					)
						continue;
					this.enqueue(binding, peer, "share-memory-proposal", proposal.mutation);
					this.store.sharingPut(`proposal-sent:${executionScope(binding)}`, proposal.mutation.operationId, true);
				}
			if (installation(peer, binding.missionHome))
				for (const proposal of this.store.sharingList<SharedMissionProposal>(`proposal:${binding.bindingId}`)) {
					if (
						proposal.state !== "pending" ||
						this.store.sharingGet(`proposal-sent:${executionScope(binding)}`, proposal.proposalId)
					)
						continue;
					this.enqueue(binding, peer, "share-mission-proposal", proposal);
					this.store.sharingPut(`proposal-sent:${executionScope(binding)}`, proposal.proposalId, true);
				}
		}
		if (installation(binding.missionHome, this.host))
			for (const grant of this.store.sharedGrants(binding.bindingId)) {
				if (grant.bindingId !== binding.bindingId || grant.state === "sealed") continue;
				const mission = this.store.get(grant.task.mission.missionId);
				const task = mission
					? this.store.tasks(grant.task.mission.missionId).find((task) => task.id === grant.task.taskId)
					: undefined;
				if (
					(!task || mission?.status !== "active" || task.status === "dropped") &&
					grant.state !== "cancel_requested"
				)
					this.cancel(grant.delegationId);
			}
	}
	async exchange(bindingId: string, peer: OperationHost): Promise<SharedExchangeBatch> {
		return this.serial(bindingId, async () => {
			const binding = this.binding(bindingId, false);
			if (!this.peers(binding).some((item) => installation(item, peer)) || installation(peer, this.host))
				throw new Conflict("Peer is not enrolled");
			await this.prepare(binding, peer);
			const outgoing = this.outbox(bindingId, peer, 17);
			const page = outgoing.slice(0, 16);
			for (const item of page) {
				item.transmitted = true;
				this.store.sharingOutboxPut(item.operation, item);
			}
			await this.store.durable();
			return {
				bindingId,
				generation: binding.generation,
				operations: page.map((item) => item.operation),
				more: outgoing.length > page.length,
			};
		});
	}
	async acknowledge(bindingId: string, ack: SharedExchangeAcknowledgment): Promise<void> {
		await this.serial(bindingId, async () => {
			const outgoing = this.store.sharingOutboxGet<Outgoing>(ack.operation.operationId);
			if (
				!outgoing ||
				outgoing.operation.bindingId !== bindingId ||
				canonicalJSON(outgoing.operation) !== canonicalJSON(ack.operation)
			)
				throw new Conflict("Unknown immutable outgoing operation");
			const receipt = ack.receipt;
			if (
				receipt.operationId !== ack.operation.operationId ||
				receipt.payloadHash !== ack.operation.payloadHash ||
				receipt.targetId !== ack.operation.targetId ||
				canonicalJSON(receipt.destination) !== canonicalJSON(ack.operation.destination) ||
				receipt.state === "pending"
			)
				throw new Conflict("No conclusive matching receipt");
			if (!outgoing.acknowledged && receipt.state === "rejected" && ack.operation.kind === "share-memory-proposal") {
				const mutation = JSON.parse(ack.operation.payload) as SharedMemoryMutation;
				await this.memory.applyProposalOutcome(key(this.binding(bindingId, false)), {
					operationId: mutation.operationId,
					state: "rejected",
					sequence: 0,
					reason: receipt.reason,
				});
			}
			this.store.sharingTransaction(() => {
				if (outgoing.acknowledged) return;
				outgoing.acknowledged = true;
				this.store.sharingOutboxPut(ack.operation, outgoing);
				this.store.sharingPut("receipt", ack.operation.operationId, receipt);
				if (receipt.state === "rejected" && ack.operation.kind === "share-mission-proposal") {
					const proposal = JSON.parse(ack.operation.payload) as SharedMissionProposal;
					this.store.sharingPut(`proposal:${bindingId}`, proposal.proposalId, {
						...proposal,
						state: "rejected",
						reason: receipt.reason,
					});
				}
				if (receipt.state === "accepted" && ack.operation.kind === "share-offer") {
					const offered = JSON.parse(ack.operation.payload) as DelegationGrant;
					const grant = this.store.sharedGrantHistory(offered.delegationId);
					if (grant && grant.state === "reserved") {
						grant.state = "accepted";
						this.store.updateSharedGrant(grant);
					}
				}
				if (
					receipt.state === "accepted" &&
					ack.operation.kind === "share-cancel" &&
					(receipt.result as { neverAccepted?: boolean })?.neverAccepted
				) {
					const cancelled = JSON.parse(ack.operation.payload) as { delegationId: string };
					const grant = this.store.sharedGrantHistory(cancelled.delegationId);
					if (grant) {
						grant.state = "sealed";
						this.store.updateSharedGrant(grant);
					}
				}
				if (
					receipt.state === "accepted" &&
					outgoing.advance &&
					((receipt.result as { applied?: boolean; vector?: number })?.applied === true ||
						(receipt.result as { vector?: number })?.vector !== undefined)
				) {
					const binding = this.binding(bindingId, false),
						peer = this.peers(binding).find((peer) => installation(peer, ack.operation.destination))!;
					const peerKey = digest([bindingId, peer]);
					const state = this.peerState(binding, peer);
					state[outgoing.advance.kind as "memory" | "mission"] = outgoing.advance.cursor;
					this.store.sharingPut("peer", peerKey, state);
				}
				if (receipt.state === "rejected")
					this.store.sharingPut("conflict", ack.operation.operationId, {
						operationId: ack.operation.operationId,
						bindingId,
						reason: receipt.reason,
						incoming: ack.operation.payload,
					});
			});
			await this.store.durable();
			this.signal();
		});
	}
	async handle(operation: DurableOperation): Promise<unknown> {
		if (!operation.kind.startsWith("share-")) throw new OperationRejected("Unsupported shared operation");
		return this.serial(operation.bindingId ?? "", async () => {
			const binding = this.store.sharingGet<SharedContextBinding>("binding", operation.bindingId ?? "");
			if (!binding) throw new OperationRejected("Unknown explicit sharing enrollment");
			if (
				operation.bindingGeneration !== binding.generation ||
				!this.peers(binding).some((peer) => installation(peer, operation.origin)) ||
				!installation(operation.destination, this.host)
			)
				throw new OperationRejected("Sharing identity/generation fence mismatch");
			const outcomeKey = digest([binding.bindingId, binding.generation, operation.origin, operation.operationId]);
			const existing = this.store.sharingGet<{ hash: string; result: unknown }>("handled", outcomeKey);
			if (existing) {
				if (existing.hash !== operation.payloadHash)
					throw new OperationRejected("Immutable shared operation changed");
				await this.store.durable();
				return existing.result;
			}
			if (
				binding.state !== "active" &&
				![
					"share-event",
					"share-cancel",
					"share-revoke",
					"share-fragment",
					"share-memory-outcome",
					"share-mission-outcome",
				].includes(operation.kind)
			)
				throw new OperationRejected("Binding revoked; operation quarantined");
			let payload: unknown;
			try {
				payload = JSON.parse(operation.payload);
			} catch {
				throw new OperationRejected("Invalid shared payload JSON");
			}
			if (!payload || typeof payload !== "object" || Array.isArray(payload))
				throw new OperationRejected("Expected typed shared payload");
			const result = await this.apply(binding, operation.kind, payload, operation);
			this.store.sharingTransaction(() => {
				this.store.sharingPut("handled", outcomeKey, { hash: operation.payloadHash, result });
				const staging = this.completedFragments.get(operation.operationId);
				if (staging) {
					this.store.sharingDeleteStaging(staging);
					this.store.sharingDeleteStaging(`${staging}:meta`);
					this.completedFragments.delete(operation.operationId);
				}
			});
			await this.store.durable();
			this.signal();
			return result;
		});
	}
	private async apply(
		binding: SharedContextBinding,
		kind: string,
		payload: any,
		operation: DurableOperation,
	): Promise<unknown> {
		if (
			binding.state !== "active" &&
			![
				"share-event",
				"share-cancel",
				"share-revoke",
				"share-fragment",
				"share-memory-outcome",
				"share-mission-outcome",
			].includes(kind)
		)
			throw new OperationRejected("Binding revoked; assembled context quarantined");
		const fromHome = installation(operation.origin, binding.missionHome),
			fromMemory = installation(operation.origin, binding.memoryHome.host),
			fromTarget = installation(operation.origin, binding.executionProject.host);
		const requireOrigin = (allowed: boolean) => {
			if (!allowed) throw new OperationRejected("Operation is not from its enrolled authority");
		};
		if (kind === "share-fragment") {
			const fragment = payload as Fragment;
			fields(fragment, ["id", "kind", "hash", "index", "count", "text"], "context fragment");
			if (
				!id(fragment.id) ||
				!Number.isInteger(fragment.index) ||
				fragment.index < 0 ||
				!Number.isInteger(fragment.count) ||
				fragment.count < 1 ||
				fragment.count > MAX_SHARED_FRAGMENTS ||
				fragment.index >= fragment.count ||
				typeof fragment.text !== "string" ||
				fragment.text.length > 4000 ||
				!fragment.kind.startsWith("share-") ||
				fragment.kind === "share-fragment"
			)
				throw new OperationRejected("Invalid staged fragment");
			const namespace = `fragment:${digest([binding.bindingId, binding.generation, operation.origin, fragment.id])}`;
			const previous = this.store.sharingGet<Fragment>(namespace, String(fragment.index).padStart(8, "0"));
			if (previous && canonicalJSON(previous) !== canonicalJSON(fragment))
				throw new OperationRejected("Fragment changed");
			const meta = this.store.sharingGet<{ received: number; bytes: number }>(`${namespace}:meta`, "progress") ?? {
				received: 0,
				bytes: 0,
			};
			if (!previous) {
				meta.received++;
				meta.bytes += Buffer.byteLength(fragment.text);
				if (meta.bytes > MAX_SHARED_OBJECT_BYTES)
					throw new OperationRejected("Complete shared object exceeds staging quota");
			}
			this.store.sharingPut(namespace, String(fragment.index).padStart(8, "0"), fragment);
			this.store.sharingPut(`${namespace}:meta`, "progress", meta);
			if (meta.received !== fragment.count) return { staged: true };
			const parts = this.store.sharingList<Fragment>(namespace);
			if (
				parts.some(
					(part, i) =>
						part.index !== i ||
						part.hash !== fragment.hash ||
						part.kind !== fragment.kind ||
						part.count !== fragment.count,
				)
			)
				throw new OperationRejected("Inconsistent manifest fragments");
			const text = parts.map((part) => part.text).join("");
			if (payloadHash(text) !== fragment.hash) throw new OperationRejected("Manifest digest mismatch");
			const result = await this.apply(binding, fragment.kind, JSON.parse(text), operation);
			this.completedFragments.set(operation.operationId, namespace);
			return result;
		}
		if (kind === "share-memory-page") {
			requireOrigin(fromMemory);
			await this.memory.stageReplica(
				key(binding),
				payload.manifest as SharedMemoryCheckpointManifest,
				payload.page as SharedMemoryCheckpointPage,
			);
			return { staged: true };
		}
		if (kind === "share-memory-activate") {
			requireOrigin(fromMemory);
			await this.memory.activateReplica(key(binding), payload.checkpointId);
			this.rememberSync(binding, { memory: payload.sequence });
			await this.contextChanged(binding);
			return { vector: (await this.memory.replicaState(key(binding))).sequence };
		}
		if (kind === "share-memory-changes") {
			requireOrigin(fromMemory);
			await this.memory.applyReplicaChanges(key(binding), payload);
			this.rememberSync(binding, { memory: payload.head });
			await this.contextChanged(binding);
			return { applied: true };
		}
		if (kind === "share-mission-checkpoint") {
			requireOrigin(fromHome);
			const replica = this.replica(binding.bindingId),
				snapshots = payload.snapshots as SharedMissionSnapshot[];
			if (
				!Array.isArray(snapshots) ||
				snapshots.length !== binding.missionIds.length ||
				snapshots.some((snapshot) => !binding.missionIds.includes(snapshot.missionId)) ||
				!Number.isSafeInteger(payload.head) ||
				payload.head < replica.sequence
			)
				throw new OperationRejected("Incomplete or rolled-back mission checkpoint");
			this.store.sharingPut("replica", binding.bindingId, {
				sequence: payload.head,
				syncedAt: Date.now(),
				complete: true,
				missions: Object.fromEntries(snapshots.map((snapshot) => [snapshot.missionId, snapshot])),
			});
			this.rememberSync(binding, { mission: payload.head });
			await this.contextChanged(binding);
			return { applied: true };
		}
		if (kind === "share-mission-changes") {
			requireOrigin(fromHome);
			const replica = this.replica(binding.bindingId);
			if (
				!replica.complete ||
				payload.after !== replica.sequence ||
				!Number.isSafeInteger(payload.through) ||
				payload.through < payload.after
			)
				throw new Conflict("Mission cursor gap; checkpoint required");
			let previous = payload.after;
			for (const change of payload.changes as SharedMissionChange[]) {
				if (
					change.sequence <= previous ||
					change.sequence > payload.through ||
					!binding.missionIds.includes(change.missionId)
				)
					throw new OperationRejected("Invalid canonical change order");
				previous = change.sequence;
				const snapshot = replica.missions[change.missionId];
				if (!snapshot) throw new Conflict("Missing mission checkpoint");
				const index = snapshot.entities.findIndex(
					(entity) => entity.kind === change.entity.kind && entity.id === change.entity.id,
				);
				if (index >= 0) snapshot.entities[index] = change.entity;
				else snapshot.entities.push(change.entity);
				snapshot.detail = detailFromEntities(snapshot);
				snapshot.sequence = change.sequence;
			}
			replica.sequence = payload.through;
			replica.syncedAt = Date.now();
			this.store.sharingPut("replica", binding.bindingId, replica);
			this.rememberSync(binding, { mission: payload.head ?? payload.through });
			await this.contextChanged(binding);
			return { applied: true };
		}
		if (kind === "share-memory-proposal") {
			requireOrigin(fromTarget && installation(binding.memoryHome.host, this.host));
			const mutation = payload as SharedMemoryMutation;
			if (!installation(mutation.origin.host, binding.executionProject.host))
				throw new OperationRejected("Forged proposal origin");
			const outcome = await this.memory.commitSharedNote(binding.memoryHome.projectId, mutation);
			if (outcome.state === "conflict" || outcome.state === "rejected")
				this.store.sharingPut(`canonical-memory-proposal:${key(binding)}`, mutation.operationId, {
					mutation,
					state: outcome.state,
					reason: outcome.reason,
				} satisfies SharedMemoryProposal);
			this.enqueue(binding, operation.origin, "share-memory-outcome", outcome);
			return outcome;
		}
		if (kind === "share-memory-outcome") {
			requireOrigin(fromMemory);
			await this.memory.applyProposalOutcome(key(binding), payload);
			await this.contextChanged(binding);
			return { applied: true };
		}
		if (kind === "share-ready") {
			requireOrigin(fromTarget && installation(binding.missionHome, this.host));
			if (
				!Number.isSafeInteger(payload.memory) ||
				payload.memory < 0 ||
				!Number.isSafeInteger(payload.mission) ||
				payload.mission < 0 ||
				payload.complete !== true
			)
				throw new OperationRejected("Invalid target context readiness");
			const peer = this.peers(binding).find((peer) => installation(peer, operation.origin))!;
			const state = this.peerState(binding, peer),
				readinessKey = digest([binding.bindingId, peer]);
			const prior = this.store.sharingGet<{ sequence: number; memory: number; mission: number }>(
				"target-readiness",
				readinessKey,
			);
			if (prior && operation.sequence <= prior.sequence) return { ready: true, older: true };
			if (prior && (payload.memory < prior.memory || payload.mission < prior.mission))
				throw new OperationRejected("Target context storage rolled back");
			this.store.sharingPut("target-readiness", readinessKey, {
				sequence: operation.sequence,
				memory: payload.memory,
				mission: payload.mission,
			});
			this.store.sharingPut("peer", readinessKey, {
				memory: Math.max(state.memory ?? 0, payload.memory),
				mission: Math.max(state.mission ?? 0, payload.mission),
			});
			return { ready: true };
		}
		if (kind === "share-mission-proposal") {
			requireOrigin(fromTarget && installation(binding.missionHome, this.host));
			return this.commitProposal(binding, payload, operation.origin);
		}
		if (kind === "share-mission-outcome") {
			requireOrigin(fromHome);
			if (
				canonicalJSON(this.store.sharingGet(`proposal:${binding.bindingId}`, payload.proposalId) ?? null) !==
				canonicalJSON(payload)
			)
				this.store.sharingPut(
					"mission-overlay",
					binding.bindingId,
					(this.store.sharingGet<number>("mission-overlay", binding.bindingId) ?? 0) + 1,
				);
			this.store.sharingPut(`proposal:${binding.bindingId}`, payload.proposalId, payload);
			await this.contextChanged(binding);
			return { applied: true };
		}
		if (kind === "share-reference") {
			requireOrigin(fromHome);
			fields(payload, ["content", "digest"], "reference transfer");
			fields(
				payload.content,
				[
					"id",
					"sessionId",
					"projectId",
					"title",
					"kind",
					"revision",
					"createdAt",
					"updatedAt",
					"source",
					"libraries",
					"libraryVersions",
				],
				"artifact source",
			);
			if (payload.content.libraryVersions)
				fields(
					payload.content.libraryVersions,
					["react", "react-dom", "mermaid", "echarts", "motion", "d3", "three"],
					"artifact library versions",
				);
			if (digest(payload.content) !== payload.digest) throw new OperationRejected("Reference digest mismatch");
			this.store.sharingPut(`reference:${binding.bindingId}`, payload.digest, payload.content);
			return { staged: true };
		}
		if (kind === "share-offer") {
			requireOrigin(fromHome);
			return this.accept(binding, payload as DelegationGrant, operation.operationId);
		}
		if (kind === "share-cancel") {
			requireOrigin(fromHome);
			return this.cancelTarget(binding, payload.delegationId, payload.executionEpoch);
		}
		if (kind === "share-event") {
			requireOrigin(fromTarget && installation(binding.missionHome, this.host));
			return this.importEvent(binding, payload);
		}
		if (kind === "share-revoke") {
			requireOrigin(fromHome || fromMemory || fromTarget);
			this.store.sharingPut("binding", binding.bindingId, { ...binding, state: "revoked" });
			if (installation(binding.missionHome, this.host))
				for (const grant of this.store.sharedGrants(binding.bindingId))
					if (grant.bindingId === binding.bindingId && grant.state !== "sealed") this.cancel(grant.delegationId);
			for (const execution of this.executions(binding.bindingId))
				await this.cancelTarget(binding, execution.grant.delegationId, execution.grant.executionEpoch);
			return { revoked: true };
		}
		throw new OperationRejected("Unsupported shared operation kind");
	}
	private executions(bindingId?: string, mode: "active" | "export" = "active"): Execution[] {
		return (bindingId ? [this.binding(bindingId, false)] : this.bindings()).flatMap((binding) =>
			this.store.sharingExecutions<Execution>(executionScope(binding), mode),
		);
	}
	private putExecution(execution: Execution): void {
		const scope = executionScope(this.binding(execution.grant.bindingId, false));
		const previous = this.store.sharingGet<{ scope: string; id: string }>(
			"execution-session",
			execution.grant.session.sessionId,
		);
		if (previous && (previous.scope !== scope || previous.id !== execution.grant.delegationId))
			throw new OperationRejected("Target session ID already belongs to another qualified grant");
		this.store.sharingPut(scope, execution.grant.delegationId, execution);
		this.store.sharingPut("execution-session", execution.grant.session.sessionId, {
			scope,
			id: execution.grant.delegationId,
		});
	}
	membership(sessionId: string): Execution | undefined {
		const entry = this.store.sharingGet<{ scope: string; id: string }>("execution-session", sessionId);
		return entry ? this.store.sharingGet<Execution>(entry.scope, entry.id) : undefined;
	}
	assertAdmission(sessionId: string): void {
		if (this.journalFaults.has(sessionId))
			throw new Conflict("Execution journal requires recovery; allocation remains occupied");
		const execution = this.membership(sessionId);
		if (execution) this.assertBindingActive(execution.grant.bindingId);
		if (execution && execution.state !== "accepted")
			throw new Conflict("Delegated execution is fenced pending seal/release");
	}
	assertCreate(sessionId: string, operationId: string): void {
		const execution = this.membership(sessionId);
		if (execution && execution.operationId !== operationId)
			throw new Conflict("Session ID belongs to a qualified execution grant");
	}
	async assertRunnable(sessionId: string): Promise<void> {
		const execution = this.membership(sessionId);
		if (!execution) return;
		this.assertAdmission(sessionId);
		const binding = this.binding(execution.grant.bindingId, false),
			replica = this.replica(binding.bindingId);
		if (!replica.complete || replica.sequence < execution.grant.context.mission)
			throw new Conflict("Required mission replica is unavailable; delegated startup blocked");
		if (binding.shareMemory) {
			const memory = await this.memoryState(binding);
			if (!memory.complete || memory.sequence < execution.grant.context.memory)
				throw new Conflict("Required memory replica is unavailable; delegated startup blocked");
		}
		for (const ref of execution.grant.references)
			if (
				ref.requirement === "required" &&
				(!ref.digest || !this.store.sharingGet(`reference:${binding.bindingId}`, ref.digest))
			)
				throw new Conflict("Required pinned reference is unavailable; delegated startup blocked");
		for (const ref of execution.grant.references)
			if (
				ref.requirement === "required" &&
				digest(this.store.sharingGet(`reference:${binding.bindingId}`, ref.digest!)) !== ref.digest
			)
				throw new Conflict("Required reference digest no longer matches; delegated startup blocked");
		this.assertAdmission(sessionId);
	}
	private async accept(binding: SharedContextBinding, grant: DelegationGrant, operationId: string): Promise<unknown> {
		fields(
			grant,
			[
				"delegationId",
				"task",
				"executionEpoch",
				"bindingId",
				"bindingGeneration",
				"target",
				"session",
				"definitionRevision",
				"context",
				"manifestId",
				"references",
				"onlineOnlyUrls",
				"request",
				"state",
			],
			"grant",
		);
		fields(grant.task, ["mission", "taskId"], "task reference");
		fields(grant.task.mission, ["home", "missionId"], "mission reference");
		hostFields(grant.task.mission.home);
		projectFields(grant.target);
		fields(grant.session, ["host", "sessionId"], "execution session");
		hostFields(grant.session.host);
		fields(grant.context, ["memory", "mission"], "context vector");
		fields(grant.request, ["projectId", "title", "message", "model", "thinking"], "accepted execution request");
		if (!Array.isArray(grant.references) || grant.references.length > 40)
			throw new OperationRejected("Invalid required reference inventory");
		for (const ref of grant.references) referenceFields(ref);
		if (
			!id(grant.task.taskId) ||
			!id(grant.task.mission.missionId) ||
			!Number.isSafeInteger(grant.executionEpoch) ||
			grant.executionEpoch < 1 ||
			!Number.isSafeInteger(grant.definitionRevision) ||
			grant.definitionRevision < 1 ||
			![grant.context.memory, grant.context.mission].every(
				(sequence) => Number.isSafeInteger(sequence) && sequence >= 0,
			) ||
			typeof grant.manifestId !== "string" ||
			!/^[a-f0-9]{64}$/.test(grant.manifestId) ||
			grant.state !== "reserved"
		)
			throw new OperationRejected("Invalid immutable grant revision/vector");
		if (
			!installation(binding.executionProject.host, this.host) ||
			grant.bindingId !== binding.bindingId ||
			grant.bindingGeneration !== binding.generation ||
			!installation(grant.task.mission.home, binding.missionHome) ||
			!binding.missionIds.includes(grant.task.mission.missionId) ||
			canonicalJSON(grant.target) !== canonicalJSON(binding.executionProject) ||
			!installation(grant.session.host, this.host) ||
			!id(grant.session.sessionId) ||
			!id(grant.delegationId)
		)
			throw new OperationRejected("Invalid executable grant");
		if (
			this.store.sharingGet(`cancelled:${executionScope(binding)}`, `${grant.delegationId}:${grant.executionEpoch}`)
		)
			throw new OperationRejected("Execution epoch cancelled before offer");
		const prior = this.store.sharingGet<Execution>(executionScope(binding), grant.delegationId);
		if (prior) {
			if (digest(prior.grant) !== digest(grant)) throw new OperationRejected("Grant immutable bytes changed");
			if (prior.state !== "accepted") throw new OperationRejected("Grant already fenced");
		}
		const occupied = this.executions().find(
			(execution) =>
				digest(execution.grant.task) === digest(grant.task) &&
				execution.state !== "sealed" &&
				execution.grant.delegationId !== grant.delegationId,
		);
		if (occupied) throw new OperationRejected("Task already occupied on target");
		const replica = this.replica(binding.bindingId),
			memory = await this.memoryState(binding);
		if (
			!replica.complete ||
			!memory.complete ||
			replica.sequence < grant.context.mission ||
			memory.sequence < grant.context.memory ||
			!replica.missions[grant.task.mission.missionId]
		)
			throw new Conflict("Mandatory offline context is incomplete");
		for (const ref of grant.references)
			if (
				ref.requirement === "required" &&
				(!ref.digest || !this.store.sharingGet(`reference:${binding.bindingId}`, ref.digest))
			)
				throw new Conflict("Required pinned reference not installed");
		for (const ref of grant.references)
			if (
				ref.requirement === "required" &&
				digest(this.store.sharingGet(`reference:${binding.bindingId}`, ref.digest!)) !== ref.digest
			)
				throw new Conflict("Required pinned reference digest mismatch");
		const project = this.projects.require(binding.executionProject.projectId);
		if (
			grant.request.cwd !== undefined ||
			grant.request.missionId !== undefined ||
			grant.request.projectId !== binding.executionProject.projectId ||
			typeof grant.request.message !== "string" ||
			!grant.request.model
		)
			throw new OperationRejected("Grant must use target-local binding and explicit model, without imported paths");
		if (
			Object.keys(grant.request).some(
				(field) => !["projectId", "title", "message", "model", "thinking"].includes(field),
			)
		)
			throw new OperationRejected("Grant contains unapproved execution/workspace configuration");
		const selection = await this.sessions.selectTaskModel(project.path, grant.request.model, grant.request.thinking);
		this.assertBindingActive(binding.bindingId);
		if (selection.model !== grant.request.model) throw new OperationRejected("Required target model unavailable");
		if (!prior) {
			this.store.sharingTransaction(() =>
				this.putExecution({
					grant,
					operationId,
					state: "accepted",
					sequence: 0,
				} satisfies Execution),
			);
			await this.store.durable();
		}
		await this.store.durable();
		this.assertBindingActive(binding.bindingId);
		await this.sessions.spawnDurable(grant.request, grant.session.sessionId, operationId);
		return { grant: grant.delegationId, session: grant.session, context: grant.context, state: "accepted" };
	}
	async reserve(
		missionId: string,
		taskId: string,
		request: {
			bindingId: string;
			expectedRevision: number;
			/** Latest task grant at mission home, including sealed grants across bindings; zero only if absent. */
			expectedPreviousEpoch: number;
			model: string;
			thinking?: string;
			references?: SharedContextReference[];
			onlineOnlyUrls?: string[];
			message?: string;
		},
	): Promise<DelegationGrant> {
		return this.serial(request.bindingId, async () => {
			fields(
				request,
				[
					"bindingId",
					"expectedRevision",
					"expectedPreviousEpoch",
					"model",
					"thinking",
					"references",
					"onlineOnlyUrls",
					"message",
				],
				"delegation request",
			);
			if (
				!Number.isSafeInteger(request.expectedPreviousEpoch) ||
				request.expectedPreviousEpoch < 0 ||
				request.expectedPreviousEpoch >= Number.MAX_SAFE_INTEGER
			)
				throw new Conflict("expectedPreviousEpoch must be the observed nonnegative safe task epoch");
			if (request.message !== undefined && (typeof request.message !== "string" || request.message.length > 8000))
				throw new Conflict("Delegation instructions exceed bounded accepted scope");
			const binding = this.assertBindingActive(request.bindingId);
			if (!installation(binding.missionHome, this.host) || !binding.missionIds.includes(missionId))
				throw new Conflict("Only enrolled mission home can dispatch");
			this.projects.require(this.store.require(missionId).projectId);
			const task = this.store.resolveTask(missionId, taskId);
			if (request.expectedRevision !== this.store.sharedDefinitionRevision(task.id))
				throw new Conflict("Task definition CAS conflict");
			if (request.expectedPreviousEpoch !== (this.store.sharedTaskGrant(task.id)?.executionEpoch ?? 0))
				throw new Conflict("Task execution epoch CAS conflict; refresh mission-home inventory");
			if (typeof request.model !== "string" || !request.model.includes("/"))
				throw new Conflict("An explicit independently available target model is required");
			if (task.preferredModelSetBy === "user" && task.preferredModel !== request.model)
				throw new Conflict("User-set preferred task model cannot be overridden by delegation");
			const peer = this.peerState(binding, binding.executionProject.host);
			if (peer.mission === undefined || (binding.shareMemory && peer.memory === undefined))
				throw new Conflict("Install and acknowledge complete offline context before reservation");
			if (peer.mission < this.store.sharedHead()) throw new Conflict("Target mission context has not caught up");
			const detail = this.store.detail(missionId),
				references = request.references ?? [];
			if (!Array.isArray(references) || references.length > 40) throw new Conflict("Too many pinned references");
			for (const ref of references) referenceFields(ref);
			const onlineOnlyUrls = request.onlineOnlyUrls ?? [];
			if (
				!Array.isArray(onlineOnlyUrls) ||
				onlineOnlyUrls.some((url) => typeof url !== "string" || url.length > 2048)
			)
				throw new Conflict("Invalid explicit online-only references");
			for (const resource of detail.resources.filter((resource) => resource.taskId === task.id))
				if (!onlineOnlyUrls.includes(resource.url))
					throw new Conflict(
						"Classify task URLs explicitly as online-only, or pin required content as an authorized artifact before delegation",
					);
			for (const artifact of detail.artifacts.filter((artifact) => artifact.taskId === task.id))
				if (
					!references.some((ref) => ref.artifactId === artifact.artifactId && ref.sessionId === artifact.sessionId)
				)
					throw new Conflict("Classify every linked task artifact as required or optional-online");
			for (const ref of references) {
				if (
					!installation(ref.host, this.host) ||
					!Number.isSafeInteger(ref.revision) ||
					ref.revision < 1 ||
					!detail.artifacts.some(
						(artifact) => artifact.artifactId === ref.artifactId && artifact.sessionId === ref.sessionId,
					)
				)
					throw new Conflict("Reference is not pinned to an authorized mission artifact");
				if (
					detail.artifacts.some(
						(artifact) =>
							artifact.artifactId === ref.artifactId &&
							artifact.sessionId === ref.sessionId &&
							artifact.revision !== undefined &&
							artifact.revision !== ref.revision,
					)
				)
					throw new Conflict("Reference revision differs from its persisted mission pin");
				if (ref.requirement === "required") {
					const content = await this.sessions.artifact(ref.sessionId, ref.artifactId, ref.revision);
					if (
						!this.store
							.artifactReferences(missionId, ref.artifactId)
							.some((item) => item.sessionId === ref.sessionId)
					)
						throw new Conflict("Pinned artifact authorization changed while reading");
					const { html: _html, ...source } = content;
					ref.digest = digest(source);
					this.enqueue(binding, binding.executionProject.host, "share-reference", {
						digest: ref.digest,
						content: source,
					});
				}
			}
			this.assertBindingActive(binding.bindingId);
			if (
				binding.shareMemory &&
				installation(binding.memoryHome.host, this.host) &&
				peer.memory !== this.memory.summary(binding.memoryHome.projectId).count
			)
				throw new Conflict("Target memory context has not caught up with its canonical home");
			const grant: DelegationGrant = {
				delegationId: randomUUID(),
				task: { mission: { home: binding.missionHome, missionId }, taskId: task.id },
				executionEpoch: request.expectedPreviousEpoch + 1,
				bindingId: binding.bindingId,
				bindingGeneration: binding.generation,
				target: binding.executionProject,
				session: { host: binding.executionProject.host, sessionId: randomUUID() },
				definitionRevision: request.expectedRevision,
				context: { memory: peer.memory ?? 0, mission: peer.mission },
				manifestId: digest([binding, peer]),
				references,
				onlineOnlyUrls,
				request: {
					projectId: binding.executionProject.projectId,
					title: task.title,
					message: `Work only on accepted mission task #${task.number}: ${task.title}\n${task.body ?? ""}\n${request.message ?? ""}\nRead the mission and shared memory locally. Proposed edits do not expand your accepted scope. Required artifact revisions are installed; references classified optional-online need connectivity and cannot be assumed available offline.`,
					model: request.model,
					...(request.thinking ? { thinking: request.thinking } : {}),
				},
				state: "reserved",
			};
			this.store.sharingTransaction(() => {
				this.store.reserveSharedGrant(grant, request.expectedPreviousEpoch);
				this.enqueue(binding, binding.executionProject.host, "share-offer", grant);
			});
			await this.store.durable();
			this.signal();
			return grant;
		});
	}
	cancel(delegationId: string): DelegationGrant {
		const grant = this.store.sharedGrantHistory(delegationId);
		if (!grant) throw new NotFound("Unknown delegation");
		if (grant.state !== "sealed" && grant.state !== "cancel_requested")
			this.store.sharingTransaction(() => {
				grant.state = "cancel_requested";
				this.store.updateSharedGrant(grant);
				this.enqueue(this.binding(grant.bindingId, false), grant.target.host, "share-cancel", {
					delegationId,
					executionEpoch: grant.executionEpoch,
				});
			});
		this.signal();
		return grant;
	}
	private async cancelTarget(binding: SharedContextBinding, delegationId: string, epoch: number): Promise<unknown> {
		if (!id(delegationId) || !Number.isSafeInteger(epoch) || epoch < 1)
			throw new OperationRejected("Invalid cancel epoch");
		this.store.sharingPut(`cancelled:${executionScope(binding)}`, `${delegationId}:${epoch}`, true);
		const execution = this.store.sharingGet<Execution>(executionScope(binding), delegationId);
		if (!execution) return { sealed: true, neverAccepted: true };
		if (execution.grant.executionEpoch !== epoch || execution.grant.bindingId !== binding.bindingId)
			throw new OperationRejected("Cancel grant mismatch");
		if (execution.state === "sealed") return { sealed: true };
		execution.state = "cancel_requested";
		this.putExecution(execution);
		await this.store.durable();
		await this.sessions.fenceDelegatedSession(execution.grant.session.sessionId);
		await this.sessions.stop(execution.grant.session.sessionId);
		return { cancelRequested: true };
	}
	async seal(delegationId: string, bindingId?: string): Promise<{ sealed: boolean; reason?: string }> {
		const candidates = (bindingId ? [this.binding(bindingId, false)] : this.bindings()).flatMap((binding) => {
			const execution = this.store.sharingGet<Execution>(executionScope(binding), delegationId);
			return execution ? [execution] : [];
		});
		if (candidates.length > 1) throw new Conflict("Delegation ID is ambiguous; specify bindingId");
		let execution = candidates[0];
		if (!execution) throw new NotFound("Unknown target execution");
		return this.serial(execution.grant.bindingId, async () => {
			execution = this.store.sharingGet<Execution>(
				executionScope(this.binding(execution.grant.bindingId, false)),
				delegationId,
			)!;
			if (execution.state === "sealed") {
				await this.store.durable();
				return { sealed: true };
			}
			execution.state = "cancel_requested";
			this.putExecution(execution);
			await this.store.durable();
			if (!(await this.sessions.sealDelegatedSession(execution.grant.session.sessionId)))
				return { sealed: false, reason: "Agent, admissions, jobs or live child processes have not quiesced" };
			execution.state = "sealed";
			this.store.sharingTransaction(() => {
				execution = this.store.sharingGet<Execution>(
					executionScope(this.binding(execution.grant.bindingId, false)),
					delegationId,
				)!;
				execution.state = "sealed";
				this.putExecution(execution);
				this.recordEvent(execution, "sealed", { quiescent: true });
			});
			await this.store.durable();
			this.signal();
			return { sealed: true };
		});
	}
	private recordEvent(
		execution: Execution,
		kind: DelegationEvent["kind"],
		payload: Record<string, unknown>,
		signature?: string,
	): void {
		execution =
			this.store.sharingGet<Execution>(
				executionScope(this.binding(execution.grant.bindingId, false)),
				execution.grant.delegationId,
			) ?? execution;
		if (signature !== undefined) execution.lastSignature = signature;
		execution.needsFactExport = true;
		const sequence = ++execution.sequence;
		const event: DelegationEvent = {
			eventId: `${execution.grant.delegationId}:${sequence}`,
			delegationId: execution.grant.delegationId,
			executionEpoch: execution.grant.executionEpoch,
			sequence,
			kind,
			payload: {
				...payload,
				...(kind === "result"
					? {
							resultVersion: sequence,
							runId: `${execution.grant.delegationId}:${execution.grant.executionEpoch}:${sequence}`,
						}
					: {}),
			},
		};
		this.putExecution(execution);
		this.store.sharingPut(
			`events:${executionScope(this.binding(execution.grant.bindingId, false))}:${execution.grant.delegationId}`,
			String(sequence).padStart(16, "0"),
			event,
		);
	}
	audit(bindingId: string, delegationId: string, after = 0): { events: DelegationEvent[]; next?: number } {
		const binding = this.binding(bindingId, false),
			scope = executionScope(binding),
			qualified = digest([scope, delegationId]);
		if (!Number.isSafeInteger(after) || after < 0) throw new Conflict("Invalid factual event cursor");
		const events = [
			...this.store.sharingPage<DelegationEvent>(`imported:${qualified}`, String(after).padStart(16, "0"), 129),
			...this.store.sharingPage<DelegationEvent>(
				`events:${scope}:${delegationId}`,
				String(after).padStart(16, "0"),
				129,
			),
		].sort((a, b) => a.sequence - b.sequence);
		const page = events.slice(0, 128);
		return { events: page, ...(events.length > page.length ? { next: page.at(-1)!.sequence } : {}) };
	}
	private observe(session: SessionSummary): void {
		const execution = this.membership(session.id);
		if (!execution || execution.state === "sealed") return;
		const facts = {
			...(this.sessions.executionEvidence(session.id)
				? { execution: this.sessions.executionEvidence(session.id) }
				: {}),
			state: session.state,
			working: session.working,
			outcome: session.outcome ?? null,
			outcomeAt: session.outcomeAt ?? null,
			runningJobs: (session.runningJobs ?? []).map(({ id, name, state, startedAt }) => ({
				id,
				name,
				state,
				startedAt,
			})),
			pullRequests: (session.pullRequests ?? []).map(({ number, url, title, state, branch, mergedAt, stack }) => ({
				number,
				url,
				title,
				state,
				branch,
				mergedAt,
				stack,
			})),
		};
		const signature = digest(facts);
		if (execution.lastSignature === signature) return;
		this.store.sharingTransaction(() =>
			this.recordEvent(execution, session.working || !session.outcome ? "progress" : "result", facts, signature),
		);
		this.signal();
	}
	private importEvent(binding: SharedContextBinding, event: DelegationEvent): unknown {
		fields(event, ["eventId", "delegationId", "executionEpoch", "sequence", "kind", "payload"], "factual event");
		const shapes: Record<string, string[]> = {
			progress: ["state", "working", "outcome", "outcomeAt", "runningJobs", "pullRequests"],
			result: ["state", "working", "outcome", "outcomeAt", "runningJobs", "pullRequests"],
			question: ["text", "kind", "health"],
			artifact: ["host", "sessionId", "artifactId", "revision", "title", "kind", "taskId"],
			"pull-request": ["host", "sessionId", "url", "number", "state", "branch"],
			sealed: ["quiescent"],
		};
		shapes.progress!.push("execution");
		shapes.result!.push("execution", "resultVersion", "runId");
		if (!shapes[event.kind]) throw new OperationRejected("Unknown factual event schema");
		fields(event.payload, shapes[event.kind], "factual payload");
		if (event.payload.execution)
			fields(
				event.payload.execution,
				["attemptId", "inputSubmissionId", "inputOperationId", "completionEntry"],
				"execution evidence",
			);
		if (Array.isArray(event.payload.runningJobs))
			for (const job of event.payload.runningJobs) fields(job, ["id", "name", "state", "startedAt"], "job summary");
		if (Array.isArray(event.payload.pullRequests))
			for (const pr of event.payload.pullRequests)
				fields(pr, ["number", "url", "title", "state", "branch", "mergedAt", "stack"], "pull request summary");
		if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
			throw new OperationRejected("Invalid factual execution sequence");
		const grant = this.store.sharedGrantHistory(event.delegationId);
		if (
			!grant ||
			grant.bindingId !== binding.bindingId ||
			grant.executionEpoch !== event.executionEpoch ||
			!id(event.delegationId) ||
			event.eventId !== `${event.delegationId}:${event.sequence}`
		)
			throw new OperationRejected("Foreign factual event");
		const qualified = digest([executionScope(binding), event.delegationId]);
		const cursor = this.store.sharingGet<number>("event-cursor", qualified) ?? 0;
		if (event.sequence <= cursor) {
			const old = this.store.sharingGet(`imported:${qualified}`, String(event.sequence).padStart(16, "0"));
			if (digest(old) !== digest(event)) throw new OperationRejected("Factual event changed");
			return { imported: true };
		}
		if (event.sequence !== cursor + 1) throw new Conflict("Execution event cursor gap");
		this.store.sharingTransaction(() => {
			this.store.sharingPut(`imported:${qualified}`, String(event.sequence).padStart(16, "0"), event);
			this.store.sharingPut("event-cursor", qualified, event.sequence);
			if (event.kind === "sealed" && event.payload.quiescent === true) {
				grant.state = "sealed";
				this.store.updateSharedGrant(grant);
			}
			const mission = this.store.get(grant.task.mission.missionId),
				task = mission ? this.store.tasks(mission.id).find((task) => task.id === grant.task.taskId) : undefined;
			const eligible =
				task &&
				task.status !== "dropped" &&
				(grant.state === "reserved" || grant.state === "accepted") &&
				this.store.sharedAllocation(task.id)?.delegationId === grant.delegationId &&
				this.store.sharedDefinitionRevision(task.id) === grant.definitionRevision;
			if (event.kind === "artifact") {
				hostFields(event.payload.host);
				if (
					event.payload.sessionId !== grant.session.sessionId ||
					!event.payload.host ||
					!installation(event.payload.host as OperationHost, grant.session.host) ||
					!id(event.payload.artifactId) ||
					!Number.isSafeInteger(event.payload.revision) ||
					Number(event.payload.revision) < 1
				)
					throw new OperationRejected("Artifact fact does not belong to accepted execution");
				this.store.sharingPut(`remote-artifacts:${grant.delegationId}`, digest(event.payload), {
					...event.payload,
					eligible: Boolean(eligible),
					task: grant.task,
				});
			}
			if (eligible && grant.state !== "sealed") {
				if (event.payload.working === true) this.store.projectSharedProgress(grant, "in_progress");
				else if (event.kind === "result" && event.payload.outcome === "question")
					this.store.projectSharedProgress(grant, "blocked");
				else if (
					event.kind === "result" &&
					event.payload.outcome === "done" &&
					Array.isArray(event.payload.pullRequests) &&
					event.payload.pullRequests.length
				)
					this.store.projectSharedProgress(grant, "in_review");
			}
			if (mission) this.store.recordSharedFact(grant, event, Boolean(eligible));
			this.settleDoneProposals(binding, grant, event);
			// Completion is evidence, not automatic task completion or dependency satisfaction.
			if (["progress", "result", "sealed"].includes(event.kind))
				this.store.sharingPut("remote-projection", grant.delegationId, {
					event,
					eligible: Boolean(eligible),
					occupied: grant.state !== "sealed",
				});
		});
		return { imported: true };
	}
	remoteOccupied(missionId: string): boolean {
		return this.store.sharedMissionGrants(missionId).some((grant) => {
			if (grant.task.mission.missionId !== missionId || grant.state === "sealed") return false;
			const projection = this.store.sharingGet<{ event: DelegationEvent }>("remote-projection", grant.delegationId);
			return (
				projection?.event.kind !== "result" ||
				projection.event.payload.working !== false ||
				!Array.isArray(projection.event.payload.runningJobs) ||
				projection.event.payload.runningJobs.length !== 0
			);
		});
	}
	missionAllocations(missionId: string): unknown[] {
		return this.store
			.sharedMissionGrants(missionId)
			.filter((grant) => grant.task.mission.missionId === missionId)
			.map((grant) => ({
				grant,
				lastKnown: this.store.sharingGet("remote-projection", grant.delegationId),
				artifacts: this.store.sharingList(`remote-artifacts:${grant.delegationId}`),
				ownershipOccupied: grant.state !== "sealed",
				availability: "not-an-execution-outcome",
			}));
	}
	async memoryCall(
		sessionId: string,
		action: "wake" | "recall" | "zoom" | "note",
		args: Record<string, unknown>,
	): Promise<unknown> {
		const execution = this.membership(sessionId);
		if (!execution) throw new Conflict("No delegated membership");
		const binding = this.binding(execution.grant.bindingId, false);
		if (!binding.shareMemory) throw new Conflict("Memory is outside confirmed share scope");
		if (action !== "note") {
			const read = await this.memoryRead(binding, action, args);
			const nodes = Array.isArray(read.value) ? read.value : "nodes" in read.value ? read.value.nodes : [];
			const entries =
				!Array.isArray(read.value) && "entries" in read.value
					? read.value.entries
					: nodes.flatMap((node) => (node.entry ? [node.entry] : []));
			const prior =
				this.store.sharingGet<{ index: number; id: string; live: boolean }[]>("memory-view", sessionId) ?? [];
			const printed = new Map(prior.map((entry) => [entry.index, entry]));
			for (const entry of entries)
				printed.set(entry.index, { index: entry.index, id: entry.id, live: entry.replacedBy === undefined });
			this.store.sharingPut("memory-view", sessionId, [...printed.values()].slice(-256));
			await this.store.durable();
			if (action !== "wake") return read;
			const view = read.value as import("@pilot/protocol").MemoryView;
			return {
				...read,
				count: view.count,
				text: `${view.text}\n${read.proposals.map((proposal) => `[${proposal.state} share ${proposal.mutation.noteId}] ${proposal.mutation.text}`).join("\n")}`,
			};
		}
		this.assertAdmission(sessionId);
		if (binding.state !== "active") throw new Conflict("Sharing revoked; contribution quarantined");
		const replaces = Array.isArray(args.replaces) ? args.replaces : [];
		const entries =
			this.store.sharingGet<{ index: number; id: string; live: boolean }[]>("memory-view", sessionId) ?? [];
		const mutation: SharedMemoryMutation = {
			operationId: randomUUID(),
			payloadHash: "",
			noteId: randomUUID(),
			origin: { host: this.host, sessionId },
			text: String(args.text ?? ""),
			replaces: replaces.map((index) => {
				const entry = entries.find((entry) => entry.index === index);
				if (!entry?.live)
					throw new Conflict(
						"Correction index is not a live note in your pinned read view; recall the stable note first",
					);
				return { id: entry.id, expectedReplacementId: null };
			}),
		};
		mutation.payloadHash = digest({ ...mutation, payloadHash: undefined });
		if (installation(binding.memoryHome.host, this.host)) {
			const outcome = await this.memory.commitSharedNote(binding.memoryHome.projectId, mutation);
			this.scheduleContextChanged(binding);
			this.signal();
			return outcome;
		}
		const proposal = await this.memory.queueReplicaProposal(key(binding), mutation);
		this.scheduleContextChanged(binding);
		this.signal();
		return proposal;
	}
	context(sessionId: string): MissionContext | undefined {
		const execution = this.membership(sessionId);
		if (!execution) return undefined;
		const snapshot = this.replica(execution.grant.bindingId).missions[execution.grant.task.mission.missionId];
		if (!snapshot) return undefined;
		const detail = snapshot.detail,
			task = detail.tasks.find((task) => task.id === execution.grant.task.taskId),
			pins = new Set(task?.decisionIds ?? []);
		const decisions = detail.decisions.filter((decision) => decision.audience === "all" || pins.has(decision.id));
		return {
			id: detail.mission.id,
			title: detail.mission.title,
			goal: detail.mission.goal,
			status: detail.mission.status,
			coordinator: "other",
			tasks: task ? [{ number: task.number, title: task.title, status: task.status }] : [],
			decisions: decisions.map((decision) => `D${decision.number}: ${decision.text}`),
			decisionEntries: decisions.map(({ id, text }) => ({ id, text })),
			decisionVersion: digest([snapshot.sequence, decisions]),
			sharedContext: true,
		};
	}
	async missionCall(sessionId: string, action: MissionAction, args: Record<string, unknown>): Promise<unknown> {
		const execution = this.membership(sessionId);
		if (!execution) throw new Conflict("No delegated membership");
		const binding = this.binding(execution.grant.bindingId, false),
			snapshot = this.replica(binding.bindingId).missions[execution.grant.task.mission.missionId];
		if (!snapshot) throw new Conflict("Mission replica incomplete");
		const detail = snapshot.detail;
		const taskRef = args.id ?? args.taskId;
		const task =
			taskRef === undefined
				? undefined
				: detail.tasks.find(
						(task) => task.id === taskRef || String(task.number) === String(taskRef).replace(/^#/, ""),
					);
		if (action === "get" || (action === "task" && Object.keys(args).every((key) => key === "id")))
			return {
				committed: task ?? detail,
				scope: execution.grant.request.message,
				provisional: this.store.sharingList(`proposal:${binding.bindingId}`),
				canonical: false,
			};
		if (action === "tasks") return detail.tasks;
		if (action === "brief" && args.markdown === undefined) return detail.brief;
		if (action === "decisions") return detail.decisions;
		if (action === "comments") return detail.comments;
		if (action === "links") return detail.resources;
		if (action === "artifacts") return detail.artifacts;
		if (action === "activity")
			return { events: this.audit(binding.bindingId, execution.grant.delegationId), historyOnlineOnly: true };
		this.assertAdmission(sessionId);
		if (binding.state !== "active") throw new Conflict("Sharing revoked; no new proposals");
		if (!["brief", "task", "decide", "comment", "log", "link", "attach"].includes(action))
			throw new Conflict(
				"Needs mission home authority; replicas cannot claim, release, dispatch, delete or coordinate",
			);
		if (action === "task" && task && task.id !== execution.grant.task.taskId)
			throw new Conflict("Task edits outside accepted scope require home authority");
		proposalArgs(action, args);
		if (action === "attach") {
			if (
				args.taskId !== undefined &&
				args.taskId !== execution.grant.task.taskId &&
				String(args.taskId) !== String(detail.tasks.find((task) => task.id === execution.grant.task.taskId)?.number)
			)
				throw new Conflict("Artifact link exceeds accepted task scope");
			if (typeof args.artifactId !== "string") throw new Conflict("Artifact ID required");
			const artifact = await this.sessions.artifact(
				sessionId,
				args.artifactId,
				typeof args.artifactRevision === "number" ? args.artifactRevision : undefined,
			);
			this.assertAdmission(sessionId);
			const reference = {
				host: this.host,
				sessionId,
				artifactId: artifact.id,
				revision: artifact.revision,
				title: artifact.title,
				kind: artifact.kind,
				taskId: execution.grant.task.taskId,
			};
			this.store.sharingTransaction(() => this.recordEvent(execution, "artifact", reference));
			await this.store.durable();
			this.signal();
			return { reference, pendingImport: true };
		}
		if (action === "log") {
			this.store.sharingTransaction(() =>
				this.recordEvent(execution, "question", { text: String(args.text ?? ""), kind: args.kind ?? "update" }),
			);
			await this.store.durable();
			this.signal();
			return { recorded: true, pendingImport: true };
		}
		const entityId = task?.id ?? (action === "brief" ? `${detail.mission.id}:brief` : randomUUID());
		const entity = snapshot.entities.find((entity) => entity.id === entityId);
		if (Array.isArray(args.dependsOn))
			args = {
				...args,
				dependsOn: args.dependsOn.map((ref) => {
					const task = detail.tasks.find(
						(task) => task.id === ref || String(task.number) === String(ref).replace(/^#/, ""),
					);
					if (!task) throw new Conflict("Dependency absent from committed replica");
					return task.id;
				}),
			};
		const proposal: SharedMissionProposal = {
			proposalId: randomUUID(),
			missionId: detail.mission.id,
			entityId,
			expectedRevision: entity?.revision ?? 0,
			action,
			args,
			origin: { host: this.host, sessionId },
			state: "pending",
		};
		this.store.sharingPut(`proposal:${binding.bindingId}`, proposal.proposalId, proposal);
		this.store.sharingPut(
			"mission-overlay",
			binding.bindingId,
			(this.store.sharingGet<number>("mission-overlay", binding.bindingId) ?? 0) + 1,
		);
		await this.store.durable();
		this.signal();
		this.scheduleContextChanged(binding);
		return proposal;
	}
	private commitProposal(
		binding: SharedContextBinding,
		proposal: SharedMissionProposal,
		origin: OperationHost,
	): unknown {
		fields(
			proposal,
			["proposalId", "missionId", "entityId", "expectedRevision", "action", "args", "origin", "state"],
			"provisional mission contribution",
		);
		fields(proposal.origin, ["host", "sessionId"], "proposal origin");
		hostFields(proposal.origin.host);
		proposalArgs(proposal.action, proposal.args);
		if (
			proposal.state !== "pending" ||
			!id(proposal.proposalId) ||
			!id(proposal.origin.sessionId) ||
			!Number.isSafeInteger(proposal.expectedRevision) ||
			proposal.expectedRevision < 0
		)
			throw new OperationRejected("Invalid provisional contribution identity/revision");
		if (
			!binding.missionIds.includes(proposal.missionId) ||
			!installation(proposal.origin.host, binding.executionProject.host)
		)
			throw new OperationRejected("Proposal scope/origin mismatch");
		const executionGrant = this.store
			.sharedGrants()
			.find(
				(grant) =>
					grant.bindingId === binding.bindingId &&
					grant.session.sessionId === proposal.origin.sessionId &&
					grant.state !== "sealed",
			);
		if (!executionGrant) throw new OperationRejected("Proposal lacks an occupied authorized grant");
		const existing = this.store.sharingGet<SharedMissionProposal>(
			`canonical-proposal:${executionScope(binding)}`,
			proposal.proposalId,
		);
		if (existing) return existing;
		const result = { ...proposal };
		this.store.sharingTransaction(() => {
			try {
				this.store.sharingAttempt(() => {
					const kind =
						proposal.action === "brief"
							? "brief"
							: proposal.action === "task"
								? "task"
								: proposal.action === "decide"
									? "decision"
									: "comment";
					if (
						!this.store.get(proposal.missionId) ||
						(kind === "task" && proposal.entityId === executionGrant.task.taskId
							? this.store.sharedDefinitionRevision(proposal.entityId) !== executionGrant.definitionRevision
							: this.store.sharedRevision(proposal.missionId, kind, proposal.entityId) !==
								proposal.expectedRevision)
					)
						throw new Conflict("Entity changed/deleted since proposal base");
					const args = proposal.args;
					const actor = { sessionId: `shared:${digest(proposal.origin)}` };
					// Remote agents never acquire user-only decision editing or coordinator permissions through sync.
					if (proposal.action === "task") {
						const creating =
							proposal.expectedRevision === 0 &&
							!this.store.tasks(proposal.missionId).some((task) => task.id === proposal.entityId);
						if (!creating && proposal.entityId !== executionGrant.task.taskId)
							throw new Conflict("Task proposal exceeds grant scope");
						const allowed = {
							...(typeof args.title === "string" ? { title: args.title } : {}),
							...(typeof args.body === "string" ? { body: args.body } : {}),
							...(Array.isArray(args.dependsOn) ? { dependsOn: args.dependsOn as string[] } : {}),
							...(Array.isArray(args.decisionIds) ? { decisionIds: args.decisionIds as string[] } : {}),
						};
						if (args.status !== undefined) {
							if (creating || Object.keys(allowed).length)
								throw new Conflict("Separate definition edits from execution status proposals");
							if (args.status === "done") return; // Accepted proposal waits for authoritative execution facts, not a blocked transport head.
							if (!["in_progress", "blocked", "in_review"].includes(String(args.status)))
								throw new Conflict("Status requires explicit home review");
							this.store.projectSharedProgress(
								executionGrant,
								args.status as "in_progress" | "blocked" | "in_review",
							);
							result.state = "committed";
							return;
						}
						if (creating) result.canonicalId = this.store.addTask(proposal.missionId, allowed, actor).id;
						else this.store.updateTask(proposal.missionId, proposal.entityId, allowed, actor);
					} else if (proposal.action === "brief")
						this.store.writeBrief(
							proposal.missionId,
							args.markdown,
							this.store.require(proposal.missionId).briefRevision,
							actor,
						);
					else if (proposal.action === "comment")
						this.store.addComment(proposal.missionId, { text: String(args.text ?? "") }, actor);
					else if (proposal.action === "link") {
						if (
							args.taskId !== undefined &&
							args.taskId !== executionGrant.task.taskId &&
							String(args.taskId) !==
								String(this.store.task(proposal.missionId, executionGrant.task.taskId).number)
						)
							throw new Conflict("Reference exceeds accepted task scope");
						this.store.addResource(
							proposal.missionId,
							{
								url: String(args.url ?? ""),
								...(typeof args.title === "string" ? { title: args.title } : {}),
								taskId: executionGrant.task.taskId,
								relationship: "reference",
							},
							actor,
						);
					} else if (proposal.action === "decide")
						throw new Conflict("Remote decision proposal awaits explicit home review; not globally binding");
					else throw new Conflict("Reference proposal awaits home authorization/review");
					result.state = "committed";
				});
			} catch (error) {
				result.state = "conflict";
				result.reason = error instanceof Error ? error.message : "Proposal conflict";
			}
			this.store.sharingPut(`canonical-proposal:${executionScope(binding)}`, proposal.proposalId, result);
			this.enqueue(binding, origin, "share-mission-outcome", result);
		});
		return result;
	}
	private settleDoneProposals(binding: SharedContextBinding, grant: DelegationGrant, event: DelegationEvent): void {
		if (
			event.kind !== "result" ||
			event.payload.outcome !== "done" ||
			event.payload.working !== false ||
			!Array.isArray(event.payload.runningJobs) ||
			event.payload.runningJobs.length
		)
			return;
		const namespace = `canonical-proposal:${executionScope(binding)}`;
		for (const proposal of this.store.sharingList<SharedMissionProposal>(namespace)) {
			if (
				proposal.state !== "pending" ||
				proposal.action !== "task" ||
				proposal.entityId !== grant.task.taskId ||
				proposal.origin.sessionId !== grant.session.sessionId ||
				proposal.args.status !== "done"
			)
				continue;
			const outcome = { ...proposal };
			const mission = this.store.get(grant.task.mission.missionId),
				task = mission ? this.store.tasks(mission.id).find((task) => task.id === grant.task.taskId) : undefined;
			if (
				!task ||
				task.status === "dropped" ||
				binding.state !== "active" ||
				!["reserved", "accepted"].includes(grant.state) ||
				this.store.sharedAllocation(task.id)?.delegationId !== grant.delegationId ||
				this.store.sharedDefinitionRevision(grant.task.taskId) !== grant.definitionRevision
			) {
				outcome.state = "conflict";
				outcome.reason = "User definition/status/assignment intent changed since grant";
			} else {
				const project = this.projects.require(this.store.require(grant.task.mission.missionId).projectId);
				const prs = Array.isArray(event.payload.pullRequests)
					? (event.payload.pullRequests as { state?: unknown }[])
					: [];
				if (project.requirePullRequest !== false && (!prs.length || prs.some((pr) => pr.state !== "merged")))
					continue;
				this.store.projectSharedProgress(grant, "done");
				outcome.state = "committed";
			}
			this.store.sharingPut(namespace, proposal.proposalId, outcome);
			this.enqueue(binding, proposal.origin.host, "share-mission-outcome", outcome);
		}
	}
	conflicts(bindingId: string): SharedMissionProposal[] {
		const binding = this.binding(bindingId, false);
		const results = this.store
			.sharingList<SharedMissionProposal>(`canonical-proposal:${executionScope(binding)}`)
			.filter(
				(proposal) =>
					binding.missionIds.includes(proposal.missionId) &&
					proposal.state === "conflict" &&
					!this.store.sharingGet(`proposal-resolution:${executionScope(binding)}`, proposal.proposalId),
			);
		if (results.length > 128)
			throw new Conflict("Conflict inventory capacity exceeded; retained records require paged review");
		return results;
	}
	async resolveProposal(
		bindingId: string,
		proposalId: string,
		write: { expectedRevision: number; action: string; args: Record<string, unknown> },
	): Promise<SharedMissionProposal> {
		return this.serial(bindingId, async () => {
			const binding = this.binding(bindingId),
				proposal = this.store.sharingGet<SharedMissionProposal>(
					`canonical-proposal:${executionScope(binding)}`,
					proposalId,
				);
			if (
				!installation(binding.missionHome, this.host) ||
				!proposal ||
				!binding.missionIds.includes(proposal.missionId) ||
				proposal.state !== "conflict"
			)
				throw new Conflict("No unresolved proposal at this authority");
			const prior = this.store.sharingGet<{ resolution: SharedMissionProposal }>(
				`proposal-resolution:${executionScope(binding)}`,
				proposalId,
			);
			if (prior) return prior.resolution;
			const kind = write.action === "brief" ? "brief" : write.action === "decide" ? "decision" : "task";
			if (this.store.sharedRevision(proposal.missionId, kind, proposal.entityId) !== write.expectedRevision)
				throw new Conflict("Resolution CAS conflict; reread current/base/incoming");
			const resolution = { ...proposal, args: write.args, action: write.action, state: "committed" as const };
			this.store.sharingTransaction(() => {
				if (write.action === "decide")
					resolution.canonicalId = this.store.addDecision(
						proposal.missionId,
						write.args.text,
						undefined,
						write.args.audience,
					).id;
				else if (write.action === "brief")
					this.store.writeBrief(
						proposal.missionId,
						write.args.markdown,
						this.store.require(proposal.missionId).briefRevision,
					);
				else if (write.action === "task") {
					const allowed = {
						...(typeof write.args.title === "string" ? { title: write.args.title } : {}),
						...(typeof write.args.body === "string" ? { body: write.args.body } : {}),
						...(typeof write.args.status === "string"
							? { status: write.args.status as import("@pilot/protocol").MissionTaskStatus }
							: {}),
						...(Array.isArray(write.args.dependsOn) ? { dependsOn: write.args.dependsOn as string[] } : {}),
						...(Array.isArray(write.args.decisionIds) ? { decisionIds: write.args.decisionIds as string[] } : {}),
					};
					if (write.expectedRevision === 0)
						resolution.canonicalId = this.store.addTask(proposal.missionId, allowed).id;
					else this.store.updateTask(proposal.missionId, proposal.entityId, allowed);
				} else throw new Conflict("Unsupported explicit resolution");
				this.store.sharingPut(`proposal-resolution:${executionScope(binding)}`, proposalId, {
					resolution,
					base: proposal,
					expectedRevision: write.expectedRevision,
				});
				this.enqueue(binding, proposal.origin.host, "share-mission-outcome", resolution);
			});
			await this.store.durable();
			this.signal();
			return resolution;
		});
	}
	async readArtifact(
		sessionId: string,
		artifactId: string,
		revision?: number,
	): Promise<Omit<ArtifactRevision, "html">> {
		const execution = this.membership(sessionId);
		if (!execution) throw new Conflict("No delegated membership");
		const ref = execution.grant.references.find(
			(ref) => ref.artifactId === artifactId && (revision === undefined || ref.revision === revision),
		);
		if (ref?.requirement !== "required" || !ref.digest)
			throw new Conflict("Reference is optional-online or not authorized in this grant");
		const content = this.store.sharingGet<Omit<ArtifactRevision, "html">>(
			`reference:${execution.grant.bindingId}`,
			ref.digest,
		);
		if (
			!content ||
			digest(content) !== ref.digest ||
			content.id !== ref.artifactId ||
			content.revision !== ref.revision ||
			content.sessionId !== ref.sessionId
		)
			throw new Conflict("Required pinned artifact unavailable or mismatched");
		return content;
	}
	private scheduleContextChanged(binding: SharedContextBinding): void {
		if (this.stopped) return;
		this.dirtyContexts.add(binding.bindingId);
		if (this.contextJobs.has(binding.bindingId)) return;
		const job = Promise.resolve()
			.then(async () => {
				do {
					this.dirtyContexts.delete(binding.bindingId);
					await this.contextChanged(binding);
				} while (this.dirtyContexts.has(binding.bindingId) && !this.stopped);
			})
			.catch(() => {
				/* Durable note/proposal and notice intent remain recoverable without blocking a tool reply. */
			})
			.finally(() => this.contextJobs.delete(binding.bindingId));
		this.contextJobs.set(binding.bindingId, job);
	}
	private async contextChanged(binding: SharedContextBinding): Promise<void> {
		await this.store.durable();
		if (installation(binding.executionProject.host, this.host) && binding.state === "active") {
			const replica = this.replica(binding.bindingId),
				memory = await this.memoryState(binding);
			const readyVector = digest([replica.sequence, memory.sequence]);
			if (
				replica.complete &&
				memory.complete &&
				this.store.sharingGet("ready-vector", binding.bindingId) !== readyVector
			) {
				this.enqueue(binding, binding.missionHome, "share-ready", {
					memory: memory.sequence,
					mission: replica.sequence,
					complete: true,
				});
				this.store.sharingPut("ready-vector", binding.bindingId, readyVector);
			}
		}
		for (const execution of this.executions(binding.bindingId)) {
			const sessionId = execution.grant.session.sessionId;
			this.sessions.missionChanged(sessionId, this.context(sessionId));
			if (execution.state !== "accepted" || !this.sessions.get(sessionId)) continue;
			const replica = this.replica(binding.bindingId),
				memory = await this.memoryState(binding);
			const noticeId = `shared-context:${binding.bindingId}:${replica.sequence}:${memory.sequence}:${memory.overlayRevision ?? 0}:${this.store.sharingGet<number>("mission-overlay", binding.bindingId) ?? 0}`;
			const previous = this.store.sharingGet<{ id: string; delivered: boolean }>("context-notice", sessionId);
			if (previous?.id === noticeId && previous.delivered) continue;
			this.store.sharingPut("context-notice", sessionId, { id: noticeId, delivered: false });
			await this.store.durable();
			await this.sessions.sharedContextNotice(
				sessionId,
				noticeId,
				"Shared context changed. Re-read mission and memory: current committed context supersedes older context; pending proposals are not binding scope or decisions.",
			);
			this.store.sharingPut("context-notice", sessionId, { id: noticeId, delivered: true });
			await this.store.durable();
		}
	}
	private rememberSync(binding: SharedContextBinding, head: Partial<{ memory: number; mission: number }>): void {
		const previous = this.store.sharingGet<{
			observedHead: { memory: number; mission: number };
			lastSyncedAt: number;
		}>("freshness", binding.bindingId);
		this.store.sharingPut("freshness", binding.bindingId, {
			observedHead: {
				memory: Math.max(previous?.observedHead.memory ?? 0, head.memory ?? 0),
				mission: Math.max(previous?.observedHead.mission ?? 0, head.mission ?? 0),
			},
			lastSyncedAt: Date.now(),
		});
	}
	async summaries(): Promise<SharedContextSummary[]> {
		await this.store.durable();
		const byBinding = new Map<string, DelegationGrant[]>();
		for (const grant of this.store.sharedGrants()) {
			const group = byBinding.get(grant.bindingId) ?? [];
			group.push(grant);
			byBinding.set(grant.bindingId, group);
		}
		const result: SharedContextSummary[] = [];
		for (const binding of this.bindings()) {
			const freshness = emptyFreshness(),
				replica = this.replica(binding.bindingId);
			Object.assign(freshness, this.store.sharingGet("freshness", binding.bindingId) ?? {});
			freshness.applied.mission = installation(binding.missionHome, this.host)
				? this.store.sharedHead()
				: replica.sequence;
			freshness.complete = installation(binding.missionHome, this.host) || replica.complete;
			if (binding.shareMemory && installation(binding.memoryHome.host, this.host))
				freshness.applied.memory = this.memory.summary(binding.memoryHome.projectId).count;
			if (binding.shareMemory && !installation(binding.memoryHome.host, this.host)) {
				const memory = await this.memory.replicaState(key(binding));
				freshness.applied.memory = memory.sequence;
				freshness.complete &&= memory.complete;
				freshness.pendingCount += memory.pendingCount;
				freshness.conflictCount += memory.conflictCount;
			}
			const proposals = this.store.sharingList<SharedMissionProposal>(`proposal:${binding.bindingId}`);
			freshness.pendingCount += proposals.filter((proposal) => proposal.state === "pending").length;
			freshness.conflictCount += proposals.filter((proposal) => proposal.state === "conflict").length;
			result.push({
				binding,
				freshness,
				grants: [
					...(byBinding.get(binding.bindingId) ?? []),
					...this.executions(binding.bindingId).map((execution) => ({
						...execution.grant,
						state: execution.state,
					})),
				],
			});
		}
		if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
			throw new Conflict("Sharing inventory exceeds bounded response capacity; safety records retained");
		return result;
	}
	async recover(): Promise<void> {
		for (const execution of this.executions()) {
			if (execution.state !== "accepted") continue;
			try {
				await this.serial(execution.grant.bindingId, async () => {
					this.assertBindingActive(execution.grant.bindingId);
					await this.assertRunnable(execution.grant.session.sessionId);
					await this.sessions.spawnDurable(
						execution.grant.request,
						execution.grant.session.sessionId,
						execution.operationId,
					);
				});
			} catch {
				this.store.sharingPut(
					"blocked-recovery",
					digest([execution.grant.bindingId, execution.grant.delegationId]),
					{
						blocked: true,
						reason: "Required context, binding or stable start intent needs recovery; ownership retained",
					},
				);
			}
		}
		for (const binding of this.bindings())
			if (binding.state === "active") {
				try {
					await this.contextChanged(binding);
				} catch {
					/* One damaged sharing partition must not stop Local. */
				}
			}
	}
	async stop(): Promise<void> {
		this.stopped = true;
		for (const unsubscribe of this.subscriptions) unsubscribe();
		await Promise.allSettled(this.queues.values());
		await Promise.allSettled(this.contextJobs.values());
	}
}

function detailFromEntities(snapshot: SharedMissionSnapshot): MissionDetail {
	const detail = structuredClone(snapshot.detail),
		live = (kind: SharedEntity["kind"]) =>
			snapshot.entities.filter((entity) => entity.kind === kind && !entity.deleted).map((entity) => entity.value);
	const mission = live("mission")[0] as MissionDetail["mission"] | undefined;
	if (mission) detail.mission = { ...detail.mission, ...mission };
	detail.tasks = live("task") as MissionTask[];
	detail.phases = live("phase") as MissionDetail["phases"];
	detail.mission.tasksDone = detail.tasks.filter((task) => task.status === "done").length;
	detail.mission.tasksTotal = detail.tasks.filter((task) => task.status !== "dropped").length;
	detail.mission.needsYouCount = detail.tasks.filter((task) => task.status === "blocked").length;
	detail.decisions = live("decision") as MissionDetail["decisions"];
	detail.comments = live("comment") as MissionDetail["comments"];
	detail.resources = live("resource") as MissionDetail["resources"];
	detail.artifacts = live("artifact") as MissionDetail["artifacts"];
	detail.brief = live("brief")[0] as MissionDetail["brief"];
	if (!mission) detail.mission.status = "archived";
	return detail;
}
