import { randomUUID } from "node:crypto";
import { Conflict } from "../../runtime/contracts/errors.ts";
import type {
	IssueIdentity,
	IssueText,
	LinearPublisherStore,
	Pending,
	PublisherState,
} from "../../sources/linear/linear-publisher-store.ts";
import { canonicalJSON, payloadHash } from "../../transport/operations/operation-journal.ts";
import type { SourceMcpClient } from "../../sources/auth/source-mcp.ts";
import { SourceConfigurationError, SourceNotDispatched, SourceSignInRequired } from "../../sources/source-tool-rules.ts";
import { OPAQUE_ID } from "../../runtime/contracts/validate.ts";

export interface PublishTask {
	id: string;
	number: number;
	title: string;
	outcome: string;
	criteria: string[];
	checks: string[];
	dependsOn: string[];
}
export interface PublishContext {
	projectName: string;
	parentUrls: string[];
	revision: string;
	tasks: PublishTask[];
	removed?: string[];
}
type Selection = { parentUrl: string; taskIds: string[] };
type Intent =
	| { action: "read" | "check" }
	| { action: "setting"; enabled: boolean; revision: number }
	| ({ action: "preview" } & Selection)
	| ({ action: "publish" | "reconcile"; pin: string } & Selection);
type Issue = IssueIdentity &
	IssueText & { parentId: string | null; teamId: string; eligible: boolean; blocks: string[] | null };
type Draft = {
	taskId: string;
	after: IssueText;
	before: IssueText | null;
	issue: IssueIdentity | null;
	change: "create" | "update" | "unchanged" | "manual";
};
type Edge = { from: string; to: string };
type Link = Edge & { label: string; change: "add" | "present" | "kept" | "removed-in-linear" | "later" };
type Edit = { taskId: string; issue: IssueIdentity; sent: IssueText; current: IssueText };
type Preview = {
	parent: IssueIdentity & { title: string; teamId: string };
	issues: Draft[];
	links: Link[];
	edits: Edit[];
	pin: string | null;
};

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash = (v: unknown) => payloadHash(canonicalJSON(v));
const marker = (missionId: string, taskId: string) => `Pilot publication reference: ${hash([missionId, taskId])}`;
const identity = ({ uuid, identifier, url }: IssueIdentity) => ({ uuid, identifier, url });
const fields = ({ title, description }: IssueText) => ({ title, description });
const edgeKey = (edge: Edge) => `${edge.from}/${edge.to}`;
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const object = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const issuePath = (url: unknown) =>
	typeof url === "string"
		? /^https:\/\/linear\.app\/([a-z0-9_-]+)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^?#]*)?\/?(?:[?#].*)?$/i.exec(url)
		: null;
export const isPublishParentUrl = (url: string) => issuePath(url) !== null;

function readIssue(value: unknown): Issue {
	const v = object(value);
	const path = issuePath(v.url);
	const issueUuid = v.uuid ?? v.id;
	const identifier = v.identifier ?? (v.id === issueUuid ? path?.[2] : v.id);
	const relations = object(v.relations);
	const blocks = Array.isArray(relations.blocks)
		? relations.blocks.map((item) =>
				typeof item === "string" ? item : (object(item).identifier ?? object(item).id ?? object(item).uuid),
			)
		: null;
	if (
		typeof issueUuid !== "string" ||
		!uuid.test(issueUuid) ||
		typeof v.teamId !== "string" ||
		!uuid.test(v.teamId) ||
		typeof identifier !== "string" ||
		path?.[2]?.toUpperCase() !== identifier.toUpperCase() ||
		typeof v.title !== "string" ||
		!v.title ||
		(v.description !== undefined && v.description !== null && typeof v.description !== "string") ||
		(v.parentId !== null && (typeof v.parentId !== "string" || !uuid.test(v.parentId)))
	)
		throw new Conflict("Linear did not return the issue details needed to publish safely.");
	return {
		uuid: issueUuid,
		teamId: v.teamId,
		identifier,
		url: v.url as string,
		title: v.title,
		description: v.description ?? "",
		parentId: v.parentId,
		eligible:
			v.archivedAt === null &&
			["triage", "backlog", "unstarted", "started", "completed"].includes(String(v.statusType)),
		blocks: blocks?.every(
			(id): id is string => typeof id === "string" && (uuid.test(id) || /^[a-z][a-z0-9]*-\d+$/i.test(id)),
		)
			? blocks
			: null,
	};
}

function parse(value: unknown): Intent {
	const v = object(value);
	const invalid = () => new Conflict("That publishing request is not valid.");
	const only = (...keys: string[]) =>
		Object.keys(v).length === keys.length && Object.keys(v).every((k) => keys.includes(k));
	if ((v.action === "read" || v.action === "check") && only("action")) return { action: v.action };
	if (
		v.action === "setting" &&
		only("action", "revision", "enabled") &&
		typeof v.enabled === "boolean" &&
		typeof v.revision === "number" &&
		Number.isSafeInteger(v.revision) &&
		v.revision >= 0
	)
		return { action: v.action, enabled: v.enabled, revision: v.revision };
	if (
		typeof v.parentUrl !== "string" ||
		v.parentUrl.length > 2000 ||
		!isPublishParentUrl(v.parentUrl) ||
		!Array.isArray(v.taskIds) ||
		!v.taskIds.length ||
		!v.taskIds.every((id) => typeof id === "string" && OPAQUE_ID.test(id)) ||
		new Set(v.taskIds).size !== v.taskIds.length
	)
		throw invalid();
	// Each task can use several MCP worker connections. Keep one foreground batch short and let the user split it.
	if (v.taskIds.length > 8) throw new Conflict("Select up to 8 tasks per preview and publish the rest separately.");
	const selection = { parentUrl: v.parentUrl, taskIds: v.taskIds as string[] };
	if (v.action === "preview" && only("action", "parentUrl", "taskIds")) return { ...selection, action: v.action };
	if (
		(v.action === "publish" || v.action === "reconcile") &&
		only("action", "parentUrl", "taskIds", "pin") &&
		typeof v.pin === "string" &&
		/^[0-9a-f]{64}$/.test(v.pin)
	)
		return { ...selection, action: v.action, pin: v.pin };
	throw invalid();
}

function description(task: PublishTask, context: PublishContext, parent: IssueIdentity, reference: string) {
	const list = (items: string[]) => items.map((s) => `- ${s}`).join("\n");
	return [
		`Part of ${parent.identifier} in ${context.projectName}.`,
		`## Outcome\n${task.outcome}`,
		`## Acceptance criteria\n${list(task.criteria)}`,
		`## Checks\n${list(task.checks)}`,
		"## Dependencies\n" +
			(task.dependsOn.length
				? list(
						task.dependsOn.map((id) => {
							const other = context.tasks.find((t) => t.id === id);
							return other ? other.title : "Prerequisite remains in the Pilot plan.";
						}),
					)
				: "None."),
		reference,
	].join("\n\n");
}

const readFields = ["id", "uuid", "title", "description", "url", "teamId", "parentId", "archivedAt", "statusType"];
function containsEdge(from: Issue, to: IssueIdentity) {
	if (!from.blocks)
		throw new Conflict("This Linear connection did not verify blocking links. No link changes were sent.");
	return from.blocks.some(
		(id) => id.toLowerCase() === to.uuid.toLowerCase() || id.toUpperCase() === to.identifier.toUpperCase(),
	);
}

/** User-only publisher. Nothing in planning, sync or recovery calls a write on its behalf. */
export class MissionLinearPublisher {
	private readonly previews = new Map<string, { pin: string; digest: string }>();
	private readonly nonce = randomUUID();
	private readonly projectsSaving = new Set<string>();
	private activeMission?: string;
	private readonly store: LinearPublisherStore;
	private readonly context: (projectId: string, missionId: string) => PublishContext;
	private readonly mcp: SourceMcpClient;
	constructor(
		store: LinearPublisherStore,
		context: (projectId: string, missionId: string) => PublishContext,
		mcp: SourceMcpClient,
	) {
		this.store = store;
		this.context = context;
		this.mcp = mcp;
	}
	private snapshot(projectId: string, missionId: string, message = "", preview?: Preview) {
		const context = this.context(projectId, missionId);
		const state = this.store.get(missionId);
		return {
			...this.store.setting(projectId),
			projectId,
			missionId,
			projectName: context.projectName,
			parentUrls: state.parent ? [state.parent.url] : context.parentUrls,
			tasks: context.tasks.map(({ id, number, title }) => ({ id, number, title })),
			mappings: state.mappings.map(({ taskId, title, identifier, url }) => ({
				taskId,
				title,
				identifier,
				url,
				removed: context.removed?.includes(taskId) ?? false,
			})),
			pending: state.pending ? (state.pending.kind === "link" ? "blocking link" : state.pending.after.title) : null,
			preview: preview ?? null,
			message,
		};
	}
	async request(projectId: string, missionId: string, value: unknown) {
		const op = parse(value);
		this.context(projectId, missionId); // Project/mission binding, even for local settings and checks.
		await this.store.durable();
		if (op.action === "read") return this.snapshot(projectId, missionId);
		if (op.action === "setting") {
			if (this.projectsSaving.has(projectId) || this.store.setting(projectId).revision !== op.revision)
				return this.snapshot(projectId, missionId, "The publishing setting changed. Check the current value.");
			this.projectsSaving.add(projectId);
			try {
				await this.store.set(projectId, op.enabled);
				return this.snapshot(projectId, missionId);
			} finally {
				this.projectsSaving.delete(projectId);
			}
		}
		if (this.activeMission)
			return this.snapshot(projectId, missionId, "Another Linear publishing request is in progress.");
		this.activeMission = missionId;
		const signal = AbortSignal.timeout(90_000);
		try {
			const context = this.context(projectId, missionId);
			const setting = this.store.setting(projectId);
			const state = this.store.get(missionId);
			const localPin = hash([context, setting]);
			const current = () => {
				signal.throwIfAborted();
				if (
					this.projectsSaving.has(projectId) ||
					localPin !== hash([this.context(projectId, missionId), this.store.setting(projectId)])
				)
					throw new Conflict("The approved plan or publishing setting changed. Preview again.");
			};
			if (op.action === "check") {
				const checked = state.pending ? await this.check(missionId, state, signal) : null;
				return this.snapshot(
					projectId,
					missionId,
					checked === "changed"
						? "Linear changed before the patch could be verified. Preview again to reconcile the current text."
						: state.pending
							? "Linear has not confirmed that change. Pilot will not resend it."
							: "No unconfirmed write. Preview any work still to publish.",
				);
			}
			if (state.pending) return this.snapshot(projectId, missionId, "Check the unconfirmed Linear write first.");
			if (!("parentUrl" in op)) throw new Conflict("Select a parent and tasks to preview.");
			const draft = await this.preview(missionId, state, context, op, signal);
			current();
			const digest = hash([projectId, missionId, localPin, state, draft]);
			const conflict = draft.edits.length || draft.links.some((e) => e.change === "removed-in-linear");
			const writable =
				!draft.issues.some((i) => i.change === "manual") &&
				(draft.issues.some((i) => ["create", "update"].includes(i.change)) ||
					draft.links.some((l) => l.change === "add"));
			if (op.action === "preview") {
				// One current preview per mission. No data is sent to Linear here except identifiers.
				const pin = hash([this.nonce, digest]);
				if ((setting.enabled && writable) || conflict) {
					// Keep only the most recent interactive preview, not a growing cache.
					this.previews.clear();
					this.previews.set(missionId, { digest, pin });
					draft.pin = pin;
				}
				return this.snapshot(projectId, missionId, "", draft);
			}
			const preview = this.previews.get(missionId);
			if (!preview || preview.digest !== digest || preview.pin !== op.pin)
				throw new Conflict("That preview changed or expired. Preview again before sending anything.");
			this.previews.delete(missionId);
			if (op.action === "reconcile") {
				if (!conflict) throw new Conflict("There are no Linear edits to reconcile.");
				for (const edit of draft.edits)
					state.mappings.find((m) => m.taskId === edit.taskId)!.baseline = edit.current;
				const removed = new Set(draft.links.filter((l) => l.change === "removed-in-linear").map(edgeKey));
				state.edges = state.edges.filter((e) => !removed.has(edgeKey(e)));
				await this.store.save(missionId, state);
				return this.snapshot(
					projectId,
					missionId,
					"Current Linear values saved for comparison. Preview again to publish.",
				);
			}
			if (!setting.enabled || conflict)
				throw new Conflict("Enable publishing and reconcile any Linear edits before publishing.");
			if (!writable) throw new Conflict("Resolve the manual changes in Linear, then preview again.");
			await this.publish(missionId, state, draft, current, signal);
			return this.snapshot(projectId, missionId, "Selected changes are in Linear.");
		} catch (e) {
			const pending = this.store.get(missionId).pending;
			const message = pending
				? "Linear did not confirm a change. Check status before publishing more."
				: e instanceof Conflict
					? e.message
					: e instanceof SourceNotDispatched
						? "This change did not reach Linear. Check the setting or connection and preview again."
						: e instanceof SourceSignInRequired
							? "Sign in to Linear in Connections, then preview again."
							: e instanceof SourceConfigurationError
								? "Publishing requires the official Linear MCP connection."
								: "Could not finish the Linear request. Check the connection and preview again.";
			return this.snapshot(projectId, missionId, message);
		} finally {
			this.activeMission = undefined;
		}
	}
	private async read(id: string, signal: AbortSignal, relations = false) {
		const result = readIssue(
			await this.mcp.call(
				"linear",
				"publishIssueRead",
				{
					id,
					fields: relations ? [...readFields, "relations"] : readFields,
				},
				signal,
			),
		);
		if (result.uuid.toLowerCase() !== id.toLowerCase() && result.identifier.toUpperCase() !== id.toUpperCase())
			throw new Conflict("Linear returned a different issue than the one requested.");
		return result;
	}
	private async child(
		parent: NonNullable<PublisherState["parent"]>,
		id: string,
		signal: AbortSignal,
		relations = false,
	) {
		const issue = await this.read(id, signal, relations);
		if (
			issue.parentId !== parent.uuid ||
			issue.teamId !== parent.teamId ||
			!issue.eligible ||
			issuePath(parent.url)?.[1] !== issuePath(issue.url)?.[1]
		)
			throw new Conflict(
				"A published issue moved or closed in Linear. Restore it under the original parent before publishing.",
			);
		return issue;
	}
	private async preview(
		missionId: string,
		state: PublisherState,
		context: PublishContext,
		selection: Selection,
		signal: AbortSignal,
	): Promise<Preview> {
		if (
			!(state.parent ? [state.parent.url] : context.parentUrls).includes(selection.parentUrl) ||
			!context.parentUrls.some(
				(url) =>
					issuePath(url)?.[1] === issuePath(selection.parentUrl)?.[1] &&
					issuePath(url)?.[2]?.toUpperCase() === issuePath(selection.parentUrl)?.[2]?.toUpperCase(),
			)
		)
			throw new Conflict("Choose a Linear parent still linked to this mission.");
		const selected = new Set(selection.taskIds);
		const tasks = context.tasks.filter((t) => selected.has(t.id));
		if (tasks.length !== selected.size)
			throw new Conflict("One or more tasks are no longer part of the approved plan.");
		const verified = await this.read(state.parent?.uuid ?? issuePath(selection.parentUrl)![2]!, signal);
		if (
			!verified.eligible ||
			verified.parentId !== null ||
			issuePath(verified.url)?.[1] !== issuePath(selection.parentUrl)?.[1] ||
			verified.identifier.toUpperCase() !== issuePath(selection.parentUrl)?.[2]?.toUpperCase() ||
			(state.parent && verified.teamId !== state.parent.teamId)
		)
			throw new Conflict("Choose an active top-level Linear issue in the linked workspace.");
		const parent = { ...identity(verified), title: verified.title, teamId: verified.teamId };

		const mapped = new Map(state.mappings.map((m) => [m.taskId, m]));
		const canLink = (id: string) => selected.has(id) || (mapped.has(id) && !context.removed?.includes(id));
		const edges = context.tasks
			.filter((t) => canLink(t.id))
			.flatMap((t) =>
				t.dependsOn
					.filter((id) => canLink(id) && (selected.has(id) || selected.has(t.id)))
					.map((id) => ({ from: id, to: t.id })),
			);
		const reads = new Map<string, Issue>();
		for (const id of new Set([...selected, ...edges.flatMap((e) => [e.from, e.to])])) {
			const mapping = mapped.get(id);
			if (mapping)
				reads.set(
					id,
					await this.child(
						parent,
						mapping.uuid,
						signal,
						edges.some((e) => e.from === id),
					),
				);
		}
		const edits: Edit[] = [];
		const issues = tasks.map((task): Draft => {
			const after = {
				title: task.title,
				description: description(task, context, parent, marker(missionId, task.id)),
			};
			const live = reads.get(task.id);
			const sent = mapped.get(task.id)?.baseline;
			const before = live ? fields(live) : null;
			if (live && sent && before && !same(sent, before))
				edits.push({ taskId: task.id, issue: identity(live), sent, current: before });
			// The MCP description patch can guard its old text. The title and an empty
			// description have no conditional write, so don't overwrite either blindly.
			const change = !before
				? "create"
				: same(before, after)
					? "unchanged"
					: before.title !== after.title || !before.description
						? "manual"
						: "update";
			return { taskId: task.id, after, before, issue: live ? identity(live) : null, change };
		});
		const name = (id: string) => {
			const task = context.tasks.find((t) => t.id === id);
			const issue = reads.get(id) ?? mapped.get(id);
			return (
				(issue?.identifier ?? (task ? `#${task.number}` : "Task")) +
				" " +
				(task?.title ?? mapped.get(id)?.title ?? "")
			);
		};
		let additions = 0;
		const links = edges.map((e): Link => {
			const from = reads.get(e.from);
			const to = reads.get(e.to);
			const present = from && to && containsEdge(from, to);
			const known = state.edges.some((other) => edgeKey(other) === edgeKey(e));
			return {
				...e,
				label: `${name(e.from)} blocks ${name(e.to)}`,
				// Only enter up to 16 new relation writes in one bounded batch.
				// A later preview skips verified links and offers the remainder.
				change: present ? "present" : known ? "removed-in-linear" : ++additions <= 16 ? "add" : "later",
			};
		});
		for (const e of state.edges)
			if (
				!edges.some((desired) => edgeKey(e) === edgeKey(desired)) &&
				(selected.has(e.from) ||
					selected.has(e.to) ||
					context.removed?.includes(e.from) ||
					context.removed?.includes(e.to))
			)
				links.push({ ...e, label: `${name(e.from)} blocks ${name(e.to)}`, change: "kept" });
		return { parent, issues, links, edits, pin: null };
	}
	private async publish(
		missionId: string,
		state: PublisherState,
		draft: Preview,
		current: () => void,
		signal: AbortSignal,
	) {
		state.parent ??= { ...identity(draft.parent), teamId: draft.parent.teamId };
		const parent = state.parent;
		for (const issue of draft.issues) {
			if (issue.change !== "create" && issue.change !== "update") continue;
			const reference = marker(missionId, issue.taskId);
			const id = issue.issue?.uuid;
			if (id && !same(fields(await this.child(parent, id, signal)), issue.before))
				throw new Conflict("A Linear issue changed during publishing. Preview again to reconcile it.");
			if (!id) {
				const latest = await this.read(parent.uuid, signal);
				if (
					!latest.eligible ||
					latest.parentId !== null ||
					latest.teamId !== parent.teamId ||
					issuePath(latest.url)?.[1] !== issuePath(parent.url)?.[1] ||
					latest.title !== draft.parent.title
				)
					throw new Conflict("The parent issue changed. Preview again.");
			}
			current();
			state.pending = {
				kind: id ? "update" : "create",
				taskId: issue.taskId,
				after: issue.after,
				marker: reference,
				uuid: id,
				guard: issue.before?.description,
			};
			await this.send(
				missionId,
				state,
				current,
				signal,
				id
					? {
							id,
							patch: [
								{ op: "replace", old_string: issue.before!.description, new_string: issue.after.description },
							],
						}
					: { team: parent.teamId, parentId: parent.uuid, ...issue.after },
			);
		}
		for (const link of draft.links) {
			if (link.change !== "add" && link.change !== "present") continue;
			const from = state.mappings.find((m) => m.taskId === link.from)!;
			const to = state.mappings.find((m) => m.taskId === link.to)!;
			const live = await this.child(parent, from.uuid, signal, true);
			await this.child(parent, to.uuid, signal);
			const present = containsEdge(live, to);
			if (!present && link.change === "present")
				throw new Conflict("A blocking link changed in Linear. Preview again.");
			current();
			if (present) {
				if (!state.edges.some((e) => edgeKey(e) === edgeKey(link))) {
					state.edges.push({ from: link.from, to: link.to });
					await this.store.save(missionId, state);
				}
				continue;
			}
			state.pending = { kind: "link", from: link.from, to: link.to };
			await this.send(missionId, state, current, signal, { id: from.uuid, blocks: [to.uuid] });
		}
	}
	private async send(
		missionId: string,
		state: PublisherState,
		current: () => void,
		signal: AbortSignal,
		args: Record<string, unknown>,
	) {
		try {
			current();
		} catch (error) {
			// No connector call entered. This is the only absence we can prove locally.
			await this.clearUnsent(missionId, state);
			throw error;
		}
		let receipt: Record<string, unknown>;
		try {
			receipt = object(
				await this.mcp.call("linear", "publishIssueWrite", args, signal, async () => {
					current();
					// The connector has a ready HTTP request now. Persist entry before
					// granting this single dispatch, then check local authority again.
					await this.store.save(missionId, state);
					current();
				}),
			);
		} catch (error) {
			// Dedicated worker setup errors occur before tools/call.
			if (error instanceof SourceConfigurationError || error instanceof SourceNotDispatched) {
				await this.clearUnsent(missionId, state);
			}
			throw error;
		}
		const pending = state.pending!;
		const receiptId = receipt.uuid ?? receipt.id;
		if (
			pending.kind === "create" &&
			typeof receiptId === "string" &&
			(uuid.test(receiptId) || /^[a-z][a-z0-9]*-\d+$/i.test(receiptId))
		) {
			const live = await this.child(state.parent!, receiptId, signal);
			this.confirmIssue(state, pending, live);
			if (!state.pending) {
				await this.store.save(missionId, state);
				return;
			}
		}
		if ((await this.check(missionId, state, signal)) === "changed")
			throw new Conflict("Linear changed during the update. Preview again to reconcile the current text.");
		if (state.pending) throw new Conflict("Linear did not confirm the write.");
	}
	private async clearUnsent(missionId: string, state: PublisherState) {
		delete state.pending;
		if (!state.mappings.length) delete state.parent;
		await this.store.save(missionId, state);
	}
	private confirmIssue(state: PublisherState, pending: Exclude<Pending, { kind: "link" }>, live: Issue) {
		if (pending.kind === "create" && !live.description.split("\n").includes(pending.marker)) return;
		// A guarded patch may have kept a concurrent append. Confirm the exact
		// published text if present, then flag the extra text on the next preview.
		if (pending.kind !== "create" && !live.description.includes(pending.after.description)) return;
		const old = state.mappings.findIndex((m) => m.taskId === pending.taskId);
		const mapping = {
			...identity(live),
			taskId: pending.taskId,
			title: pending.after.title,
			baseline: pending.after,
		};
		if (state.mappings.some((m) => m.uuid === live.uuid && m.taskId !== pending.taskId)) return;
		if (old < 0) state.mappings.push(mapping);
		else state.mappings[old] = mapping;
		delete state.pending;
	}
	private async check(missionId: string, state: PublisherState, signal: AbortSignal) {
		const pending = state.pending!;
		const parent = state.parent!;
		if (pending.kind === "link") {
			const from = state.mappings.find((m) => m.taskId === pending.from)!;
			const to = state.mappings.find((m) => m.taskId === pending.to)!;
			if (containsEdge(await this.child(parent, from.uuid, signal, true), to)) {
				state.edges.push({ from: pending.from, to: pending.to });
				delete state.pending;
			}
		} else if (pending.uuid) {
			const live = await this.child(parent, pending.uuid, signal);
			this.confirmIssue(state, pending, live);
			if (state.pending && pending.kind === "update" && pending.guard && !live.description.includes(pending.guard)) {
				// The guarded old text is gone. Do not assume the update succeeded or
				// set a new baseline. The next preview asks to reconcile the edit.
				delete state.pending;
				await this.store.save(missionId, state);
				return "changed";
			}
		} else {
			const matches: Issue[] = [];
			let cursor: string | undefined;
			// Search the unique marker under this parent. An empty or incomplete
			// search (including indexing lag) is never proof of absence.
			for (let page = 0; page < 5; page++) {
				const result = object(
					await this.mcp.call(
						"linear",
						"publishChildrenRead",
						{
							parentId: parent.uuid,
							fields: readFields,
							includeArchived: true,
							query: pending.marker.split(" ").at(-1),
							limit: 25,
							...(cursor ? { cursor } : {}),
						},
						signal,
					),
				);
				if (!Array.isArray(result.issues) || typeof result.hasNextPage !== "boolean") return;
				for (const candidate of result.issues.map(readIssue))
					if (
						candidate.parentId === parent.uuid &&
						candidate.teamId === parent.teamId &&
						issuePath(candidate.url)?.[1] === issuePath(parent.url)?.[1] &&
						candidate.description.split("\n").includes(pending.marker)
					)
						matches.push(candidate);
				if (!result.hasNextPage) {
					if (matches.length === 1) this.confirmIssue(state, pending, matches[0]!);
					break;
				}
				if (typeof result.cursor !== "string" || !result.cursor || result.cursor === cursor) return;
				cursor = result.cursor;
			}
		}
		if (!state.pending) await this.store.save(missionId, state);
	}
}
