/** Fixture-only coordinator rounds. Human answers still use authenticated native HTTP. */
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

export async function interviewHistoryFixture() {
	const f = await nativePlanningFixture();
	const write = async <T extends { purpose: string }>(request: T) => {
		const scoped = { ...request, expectedRevision: f.store.plans.get(f.missionId)?.revision ?? 0 };
		return f.plan(scoped);
	};
	let round = 0;
	return {
		f,
		async nextRound() {
			if (++round === 1) {
				await write({
					purpose: "plan-map",
					destination: "Importer",
					sources: [],
					fog: [],
					questions: [
						{
							id: "formats",
							title: "Formats",
							question: "Which formats?",
							kind: "human",
							options: [],
							recommendedOptionId: null,
							dependsOn: [],
							sources: [],
						},
					],
				});
				await write({
					purpose: "plan-ask",
					topicId: "formats",
					questions: [
						{ ...f.question, id: "format-detail", prompt: "Which archive format should the importer support?" },
					],
				});
			} else {
				if (round === 2) {
					const s = f.store.interviews.latest(f.missionId)!.submission!;
					await write({
						purpose: "plan-resolve",
						questionId: "formats",
						resolution: { kind: "interview", id: s.operationId, digest: s.digest },
					});
				}
				await write({
					purpose: "plan-propose",
					spec: {
						problem: "Read archives",
						solution: `Importer version ${round}`,
						stories: [{ id: "read", text: "Read supported archives" }],
						implementation: ["Existing parser"],
						testing: ["Exact byte fixtures"],
						exclusions: ["Live activation"],
					},
					slices: [
						{
							id: "parser",
							title: "Parser",
							outcome: "Read archive",
							acceptance: ["Exact bytes"],
							storyIds: ["read"],
							dependsOn: [],
							owners: ["sol-backend"],
						},
					],
				});
				await write({ purpose: "plan-review" });
			}
		},
	};
}
