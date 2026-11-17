/** Native report reads and edits share one tracking-worker turn. No provider calls. */
import type { SlackCaseEdit, SlackOverrides } from "@pilot/protocol";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import type { TrackedItemDisk } from "./tracked-items-disk.ts";

export function readSlackReports(disk: TrackedItemDisk, projectId: string, offset = 0) {
	// Reuse the store's 100-row pages per status to limit bridge payloads and kept UI data.
	const open = disk.list({ projectId, kind: "slack", limit: 100, offset });
	const hidden = disk.list({ projectId, kind: "slack", dismissed: true, limit: 100, offset });
	const input = disk.cases.input(projectId, Date.now());
	const items = [...open.items, ...hidden.items];
	const groups = input.cases;
	const total = open.total + hidden.total;
	return {
		items,
		groups,
		total,
		complete: total === items.length,
		offset,
		more: offset + 100 < Math.max(open.total, hidden.total),
		digest: payloadHash(canonicalJSON({ items, groups, revision: input.revision, total, offset })),
	};
}

export function editSlackReport(
	disk: TrackedItemDisk,
	projectId: string,
	digest: string,
	action: string,
	value: unknown,
) {
	const raw = value as Record<string, unknown>;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid report edit");
	const { offset = 0, ...v } = raw;
	if (typeof offset !== "number") throw new Error("Invalid report page");
	const read = readSlackReports(disk, projectId, offset);
	if (read.digest !== digest) throw new Error("Reports changed. Read again before saving.");
	if (action === "report") {
		if (Object.keys(v).sort().join() !== "itemId,patch" || !read.items.some((i) => i.id === v.itemId))
			throw new Error("Report is no longer shown");
		const patch = v.patch as SlackOverrides;
		if (
			!patch ||
			typeof patch !== "object" ||
			Array.isArray(patch) ||
			!Object.keys(patch).length ||
			Object.keys(patch).some((k) => !["details", "type", "label", "severity", "status"].includes(k))
		)
			throw new Error("Invalid report correction");
		if (patch.status !== undefined && !["open", "done"].includes(patch.status))
			throw new Error("Only open or tackled can be set here");
		return disk.patch(String(v.itemId), { slack: patch });
	}
	if (action === "group") {
		if (Object.keys(v).sort().join() !== "caseId,edit" || !read.groups.some((g) => g.id === v.caseId))
			throw new Error("Group is no longer shown");
		disk.cases.edit(projectId, String(v.caseId), v.edit as SlackCaseEdit, Date.now());
		return;
	}
	throw new Error("Invalid report action");
}
