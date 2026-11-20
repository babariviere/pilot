import { Conflict } from "../../runtime/contracts/errors.ts";
import { isPublishParentUrl, type PublishContext, type PublishTask } from "../../missions/linear/mission-linear-publisher.ts";
import { publishedDefinition, sliceTaskBody } from "../../missions/planning/mission-plan-store.ts";
import type { MissionStore } from "../../missions/missions.ts";
import { canonicalJSON } from "../../transport/operations/operation-journal.ts";
import type { ProjectStore } from "../../projects/projects.ts";

// File ownership, interview IDs and worker instructions are never part of the export. Reject
// path-shaped task prose instead of trying to guess which paths are current or safe to disclose.
const codePath =
	/(?:^|[\s("'`])(?:~?\/|\.{1,2}\/|[A-Za-z]:\\)[\w.-]|\b(?:src|lib|apps|packages|scripts|tests|docs|native)\/[\w.-]+|(?:\b[\w.-]+\/)+[\w.-]+\.[a-z0-9]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|rs|go|py|rb|swift|kt|sh|json|toml|ya?ml|md)\b/i;

function revisionText(body: string) {
	const blocks = body.split(
		/\n(?=#+\s|Acceptance(?: criteria)?:|Checks:|Owned files|Chosen prototypes|Spec revision:|Stories:|Ownership:)/i,
	);
	const outcomeHeading = /^#+\s+Outcome[^\S\n]*\n/i;
	const outcome = blocks
		.find((s) => outcomeHeading.test(s.trim()))
		?.trim()
		.replace(outcomeHeading, "")
		.trim();
	const items = (heading: RegExp) =>
		blocks
			.find((s) => heading.test(s.trim()))
			?.trim()
			.replace(heading, "")
			.split("\n")
			.map((line) => line.trim().replace(/^[-*]\s+/, ""))
			.filter(Boolean) ?? [];
	return {
		outcome: outcome ?? "",
		criteria: items(/^(?:#+\s+)?Acceptance(?: criteria)?:?\s*\n/i),
		checks: items(/^(?:#+\s+)?Checks:?\s*\n/i),
	};
}

export function linearPublishContext(
	store: MissionStore,
	projects: ProjectStore,
	projectId: string,
	missionId: string,
): PublishContext {
	const project = projects.require(projectId);
	const mission = store.require(missionId);
	if (mission.projectId !== projectId) throw new Conflict("This mission does not belong to that project.");
	const detail = store.detail(missionId, false);
	const parentUrls = detail.resources
		.filter((r) => !r.taskId && r.kind === "linear.issue" && isPublishParentUrl(r.url))
		.map((r) => r.url);
	const plan = store.plans.get(missionId);
	const publication = plan?.publication;
	const live = new Map(detail.tasks.map((t) => [t.id, t]));
	const removed =
		publication?.tasks
			.filter(({ taskId }) => !live.has(taskId) || live.get(taskId)?.status === "dropped")
			.map(({ taskId }) => taskId) ?? [];
	const result: PublishContext = { projectName: project.name, parentUrls, tasks: [], removed, revision: "" };
	if (
		!plan ||
		!publication ||
		mission.status !== "active" ||
		publication.briefRevision !== store.brief(missionId)?.revision ||
		publication.submissionDigest !== store.interviews.latest(missionId)?.submission?.digest
	)
		return result;
	result.revision = String(plan.revision);
	for (const entry of publication.tasks) {
		const task = live.get(entry.taskId);
		if (!task || task.status === "dropped") continue;
		const slice = plan.slices.find((s) => s.id === entry.sliceId);
		const deps = task.dependsOn ?? [];
		const bodyRevision = Number(/\n\nSpec revision: (\d+)\nStories: /.exec(task.body ?? "")?.[1]);
		const original = slice && sliceTaskBody(plan, slice, bodyRevision);
		const sameText = original && task.body === original;
		const initial =
			slice &&
			task.title === slice.title &&
			bodyRevision === publication.briefRevision &&
			sameText &&
			!task.assignment &&
			!task.decisionIds?.length &&
			canonicalJSON(deps) ===
				canonicalJSON(slice.dependsOn.map((id) => publication.tasks.find((p) => p.sliceId === id)?.taskId));
		if (entry.definition ? publishedDefinition(task) !== entry.definition : !initial) continue;
		const detail =
			sameText && slice
				? { outcome: slice.outcome, criteria: slice.acceptance, checks: [] }
				: revisionText(task.body ?? "");
		if (
			!detail.outcome ||
			!detail.criteria.length ||
			[task.title, detail.outcome, ...detail.criteria, ...detail.checks].some((s) => codePath.test(s))
		)
			continue;
		const row: PublishTask = {
			id: task.id,
			number: task.number,
			title: task.title,
			outcome: detail.outcome,
			criteria: detail.criteria,
			checks: detail.checks.length
				? detail.checks
				: detail.criteria.map((criterion) => `Verify in the affected workflow: ${criterion}`),
			dependsOn: deps,
		};
		result.tasks.push(row);
	}
	return result;
}
