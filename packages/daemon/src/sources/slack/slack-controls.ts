/** Native Slack settings and explicit imports. Reads never poll or call a provider. */
import type { DurableOperation, ProjectTrackingConfig, TrackedItem } from "@pilot/protocol";
import { canonicalJSON, payloadHash } from "../../runtime/contracts/canonical.ts";
import { NotFound } from "../../runtime/contracts/errors.ts";
import { parseIntent, SerialAdmissions } from "../../day/host/native-intent.ts";
import { type OperationJournal, OperationRejected } from "../../transport/operations/operation-journal.ts";
import type { ControlOperation } from "../../transport/operations/operations.ts";
import { type ProjectStore, validateTrackingConfig } from "../../projects/projects.ts";
import { parseSlackMessageLink } from "./slack-format.ts";
import { slackChannelProgress } from "./slack-source.ts";
import { SlackImportRefused } from "./slack-tracking.ts";
import { sourceId } from "../source-kinds.ts";
import type { SourceRegistry } from "../sources.ts";

export const SLACK_CONTROLS = "slack-controls";
const OUTCOME_UNKNOWN = "Slack outcome unknown; lookup only";
/** Do not save credentials, arbitrary query strings or fragments in either command journal. */
export function safeSlackLink(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 2000 &&
		/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[CDG][A-Z0-9]{1,199}\/p\d{16,18}\/?(?:\?(?:thread_ts=\d{1,12}\.\d{6}|cid=[CDG][A-Z0-9]{1,199})(?:&(?:thread_ts=\d{1,12}\.\d{6}|cid=[CDG][A-Z0-9]{1,199}))?)?$/.test(
			value,
		) &&
		!!parseSlackMessageLink(value)
	);
}

export class SlackControls {
	private readonly admissions = new SerialAdmissions(OUTCOME_UNKNOWN);
	private readonly projects: ProjectStore;
	private readonly tracking: SourceRegistry;
	constructor(projects: ProjectStore, tracking: SourceRegistry) {
		this.projects = projects;
		this.tracking = tracking;
	}
	async read(projectId: string, offset = 0) {
		const project = this.projects.require(projectId);
		const config = project.tracking ?? { slackChannels: [] };
		const source = this.tracking.require(sourceId(projectId, "slack"));
		const checkpoint = this.tracking.items.checkpoint(source.id);
		// A fresh binding fences other project edits too. Coverage changes alone do not invalidate a form.
		const binding = payloadHash(canonicalJSON(project));
		const progress = slackChannelProgress(
			source.lastPolledAt === undefined ? undefined : checkpoint?.cursor,
			config.slackChannels,
			true,
		);
		return {
			reports: await this.tracking.items.slackReports(projectId, offset),
			labels: config.slackLabels ?? [],
			version: 1,
			projectId,
			projectName: project.name,
			binding,
			config: {
				channels: config.slackChannels,
				mentionOnly: config.slackMentionOnlyChannels ?? [],
				groups: config.slackGroupHandles ?? [],
			},
			source,
			channels: config.slackChannels.map((id, index) => ({ id, ...progress[index] })),
			coverage: { startupDays: 7, replyOnlyMentions: "not_discovered", complete: false },
		};
	}
	admit(op: DurableOperation, journal: OperationJournal, firstEntry: boolean): Promise<unknown> {
		return this.admissions.admit(firstEntry, () => this.apply(op, journal));
	}
	private async apply(op: DurableOperation, journal: OperationJournal) {
		const p = parseIntent(
			op,
			journal.destination,
			SLACK_CONTROLS,
			["action", "binding", "projectId", "purpose", "value"],
			"Invalid Slack intent",
		) as { purpose: string; projectId: string; binding: string; action: string; value: unknown };
		if (op.targetId !== p.projectId || op.bindingGeneration !== 1)
			throw new OperationRejected("Invalid Slack intent");
		let current: Awaited<ReturnType<SlackControls["read"]>>;
		try {
			current = await this.read(p.projectId);
		} catch (error) {
			if (error instanceof NotFound) throw new OperationRejected("Project is no longer available.");
			throw error;
		}
		if (p.binding !== current.binding || op.bindingId !== p.binding)
			throw new OperationRejected("Project changed. Read again.");
		// Recheck the live project after the tracking-worker read.
		if (payloadHash(canonicalJSON(this.projects.require(p.projectId))) !== p.binding)
			throw new OperationRejected("Project changed. Read again.");
		if (p.action === "report" || p.action === "group") {
			const v = p.value as Record<string, unknown>;
			if (!v || typeof v !== "object" || typeof v.digest !== "string")
				throw new OperationRejected("Invalid report edit");
			const { digest, ...value } = v;
			const patch = value.patch as { label?: unknown } | undefined;
			if (p.action === "report" && patch?.label != null && !current.labels.some((l) => l.name === patch.label))
				throw new OperationRejected("Invalid project Slack label");
			try {
				await this.tracking.items.editSlackReport(p.projectId, digest, p.action, value);
			} catch (error) {
				// Worker validation is before mutation; persistence/transport errors remain Unknown.
				if (
					error instanceof Error &&
					/^(Reports changed|Report is no longer|Group is no longer|Invalid |Only open|Common case limit reached|Unknown common case|limit must)/.test(
						error.message,
					)
				)
					throw new OperationRejected(error.message);
				throw error;
			}
			return { action: p.action, projectId: p.projectId, saved: true };
		}
		if (p.action === "save") {
			let tracking: ProjectTrackingConfig;
			try {
				const v = p.value as { channels: string[]; mentionOnly: string[]; groups: string[] };
				if (!v || Object.keys(v).sort().join() !== "channels,groups,mentionOnly") throw new Error();
				tracking = validateTrackingConfig({
					...this.projects.require(p.projectId).tracking,
					slackChannels: v.channels,
					slackMentionOnlyChannels: v.mentionOnly,
					slackGroupHandles: v.groups,
				});
			} catch {
				throw new OperationRejected("Invalid Slack tracking settings");
			}
			// No await between the binding check and ProjectStore's synchronous replacement.
			await this.projects.update(p.projectId, { tracking });
			return { action: "save", projectId: p.projectId, saved: true };
		}
		if (p.action === "import") {
			const v = p.value as { url: unknown };
			if (!v || Object.keys(v).join() !== "url" || !safeSlackLink(v.url))
				throw new OperationRejected("Paste a Slack message link without credentials");
			// From here, failures may follow provider use or a durable item save. Never replay an entered import.
			let item: TrackedItem;
			try {
				item = await this.tracking.slack.add(p.projectId, v.url);
			} catch (error) {
				if (error instanceof SlackImportRefused || error instanceof NotFound)
					throw new OperationRejected(
						error instanceof NotFound ? "Project is no longer available." : error.message,
					);
				throw error;
			}
			return { action: "import", projectId: p.projectId, itemId: item.id, saved: true };
		}
		throw new OperationRejected("Invalid Slack action");
	}
}

export const slackOperations = (
	controls: SlackControls | undefined,
	journal: OperationJournal | undefined,
): ControlOperation => ({
	kind: SLACK_CONTROLS,
	unavailable: "Native Slack unavailable",
	outcomeUnknown: OUTCOME_UNKNOWN,
	admit: journal && controls && ((op, firstEntry) => controls.admit(op, journal, firstEntry)),
});
