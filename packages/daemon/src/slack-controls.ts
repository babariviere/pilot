/** Native Slack settings and explicit imports. Reads never poll or call a provider. */
import type { DurableOperation, ProjectTrackingConfig, TrackedItem } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import { type ProjectStore, validateTrackingConfig } from "./projects.ts";
import { parseSlackMessageLink } from "./slack-format.ts";
import { slackChannelProgress } from "./slack-source.ts";
import { SlackImportRefused, type SourceRegistry } from "./sources.ts";

export const SLACK_CONTROLS = "slack-controls";
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
	private pending: Promise<unknown> = Promise.resolve();
	private readonly projects: ProjectStore;
	private readonly tracking: SourceRegistry;
	constructor(projects: ProjectStore, tracking: SourceRegistry) {
		this.projects = projects;
		this.tracking = tracking;
	}
	read(projectId: string) {
		const project = this.projects.require(projectId);
		const config = project.tracking ?? { slackChannels: [] };
		const source = this.tracking.require(`${projectId}:slack`);
		const checkpoint = this.tracking.items.checkpoint(source.id);
		// A fresh binding fences other project edits too. Coverage changes alone do not invalidate a form.
		const binding = payloadHash(canonicalJSON(project));
		const progress = slackChannelProgress(
			source.lastPolledAt === undefined ? undefined : checkpoint?.cursor,
			config.slackChannels,
			true,
		);
		return {
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
		if (!firstEntry) return Promise.reject(new Error("Slack outcome unknown; lookup only"));
		const work = this.pending.then(() => this.apply(op, journal));
		this.pending = work.catch(() => undefined);
		return work;
	}
	private async apply(op: DurableOperation, journal: OperationJournal) {
		let p: { purpose: string; projectId: string; binding: string; action: string; value: unknown };
		try {
			p = JSON.parse(op.payload);
			if (
				!p ||
				Object.keys(p).sort().join() !== "action,binding,projectId,purpose,value" ||
				p.purpose !== SLACK_CONTROLS ||
				op.kind !== SLACK_CONTROLS ||
				op.targetId !== p.projectId ||
				op.bindingGeneration !== 1 ||
				!sameHost(op.origin, journal.destination)
			)
				throw new Error();
		} catch {
			throw new OperationRejected("Invalid Slack intent");
		}
		let current: ReturnType<SlackControls["read"]>;
		try {
			current = this.read(p.projectId);
		} catch (error) {
			if (error instanceof NotFound) throw new OperationRejected("Project is no longer available.");
			throw error;
		}
		if (p.binding !== current.binding || op.bindingId !== p.binding)
			throw new OperationRejected("Project changed. Read again.");
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
				item = await this.tracking.addSlackMessage(p.projectId, v.url);
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
