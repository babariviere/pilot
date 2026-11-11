/** Canonical saved sources shared by passive native drilldown tests. No worker/provider. */
import { randomUUID } from "node:crypto";
import { interviewDigest } from "./mission-interview-contract.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

export async function mapSourceFixture() {
	const f = await nativePlanningFixture();
	const decision = f.store.addDecision(f.missionId, "Use native storage.\nKeep exact 💬 context.", undefined, "all");
	const write = (expectedRevision: number, body: string) => ({
		operationId: randomUUID(),
		requestHash: randomUUID(),
		expectedRevision,
		kind: "investigation" as const,
		title: "Storage facts",
		synopsis: "Observed storage behavior",
		body,
		sources: [{ type: "repository" as const, path: "src/store.ts", commit: "a".repeat(40) }],
		author: { type: "user" as const },
		...(expectedRevision ? { reason: "New evidence, keeping the first revision" } : {}),
	});
	const knowledge = f.store.knowledge.write(
		f.project.id,
		undefined,
		write(
			0,
			"# Question\r\nNative storage?\r\n# Findings\r\nObserved: exact 💬 bytes.\r\n# Limitations\r\nOne fixture only.",
		),
	);
	f.store.knowledge.setLink(f.missionId, knowledge.entry.id, 0, { linked: true }, { type: "user" });
	const d = { kind: "decision" as const, id: decision.id, digest: interviewDigest(decision) };
	const k = { kind: "knowledge" as const, id: knowledge.entry.id, revision: 1, linkRevision: 1 };
	const question = (id: string, kind: string, sources: unknown[]) => ({
		id,
		kind,
		title: id === "choice" ? "Storage choice" : "Storage evidence",
		question: "Which saved source backs this?",
		options: [],
		recommendedOptionId: null,
		dependsOn: [],
		sources,
	});
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Read original sources without answering",
		sources: [],
		questions: [question("choice", "human", [d]), question("fact", "research", [k])],
		fog: [
			{
				id: "later",
				area: "Future storage",
				why: "Not explored yet",
				readyWhen: "After the first version",
				dependsOn: [],
				sources: [d, k],
			},
		],
	} as { purpose: string });
	await f.plan({ purpose: "plan-resolve", expectedRevision: 1, questionId: "choice", resolution: d } as {
		purpose: string;
	});
	await f.plan({
		purpose: "plan-resolve",
		expectedRevision: 2,
		questionId: "fact",
		resolution: { kind: "knowledge", id: k.id, digest: interviewDigest(k) },
	} as { purpose: string });
	await f.store.durable();
	return {
		f,
		decision,
		knowledge,
		async fillSummary() {
			for (let i = 0; i < 41; i++) {
				const extra = f.store.knowledge.write(f.project.id, undefined, write(0, `Other saved finding ${i}`));
				f.store.knowledge.setLink(f.missionId, extra.entry.id, 0, { linked: true }, { type: "user" });
			}
			await f.store.durable();
		},
		async append() {
			f.store.knowledge.write(f.project.id, k.id, write(1, "New revision, not the cited text."));
			await f.store.durable();
		},
		async replace() {
			const replacement = f.store.addDecision(f.missionId, "Use a different store", undefined, "all");
			f.store.supersedeDecision(f.missionId, d.id, replacement.id);
			await f.store.durable();
		},
		async unlink() {
			f.store.knowledge.setLink(f.missionId, k.id, 1, { linked: false }, { type: "user" });
			await f.store.durable();
		},
	};
}
