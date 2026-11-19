import { signal, Text, View } from "nsh";
import { InsightsScreen } from "./InsightsScreen";
import {
	type InsightsControls,
	type InsightsDetail,
	type InsightsReview,
	type InsightsSnapshot,
	insightsSelection,
} from "./insightsView";
import { Action } from "./ui";

const report: InsightsDetail = {
	key: "november",
	title: "Checks repeated after a reopen",
	revision: 1,
	updatedAt: 1795084643691,
	markdown: "Three chats repeated release checks after reopening.",
	coverage: "Three chats read. At least two remain.",
	gaps: ["Two chats could not be read."],
	findingKeys: ["checks"],
	evidence: [
		{
			sessionId: "source",
			label: "Release verification",
			excerpt: "I reopened and it asked me to run the checks again.",
		},
	],
};
const finding: InsightsDetail = {
	key: "checks",
	title: "Keep confirmed checks",
	revision: 1,
	updatedAt: 1795084643691,
	lifecycle: "shipped",
	projectId: "pilot",
	proposal: "Reuse the last confirmed checks when inputs stay the same.",
	benefit: "Reopen three releases.",
	evidence: report.evidence,
};
const settings = {
	projectId: "pilot",
	model: "synthetic/terra",
	sourceProjectIds: ["pilot"],
	excludeSessionIds: [],
	perReportUsd: 2,
	monthlyUsd: 10,
	schedule: null,
};
const snapshot = signal<InsightsSnapshot>({
	binding: "fixture",
	draftBinding: "fixture",
	state: "paused",
	applied: settings,
	saved: settings,
	projects: [{ id: "pilot", name: "Pilot" }],
	models: [{ id: "synthetic/terra", name: "Terra 6.1", provider: "Fixture" }],
	reports: { items: [report], nextCursor: null },
	findings: { items: [finding], nextCursor: null },
	legacy: { state: "empty", reports: [], findings: [] },
	allowance: { reportRemainingUsd: 2, monthRemainingUsd: 6.16 },
});
const count = signal(0);
const pending = signal<{ id: string; checking: boolean }[]>([]);
const work = signal("");
let prepared: InsightsReview | null = null;
const controls: InsightsControls = {
	snapshot,
	fresh: () => true,
	busy: () => false,
	message: () => "",
	models: async () => snapshot().models,
	pending,
	read: async () => {},
	more: async () => {},
	moreHistory: async () => {},
	check: async () => {},
	item: async (kind) => (kind === "reports" ? report : finding),
	prepare: async (_binding, intent) => {
		const verify = intent.action === "verify";
		const pause = intent.action === "pause";
		prepared = {
			token: "fixture",
			label: verify ? "Mark benefit verified" : pause ? "Pause Insights" : "Apply settings",
			intent,
			lines: [
				verify ? "This records your verification of the benefit." : "Applying settings will not resume Insights.",
			],
		};
		return prepared;
	},
	confirm: async (token) => {
		if (prepared?.token !== token) return false;
		if (prepared.intent.action === "pause") snapshot.set({ ...snapshot(), state: "paused", canPause: false });
		prepared = null;
		count.update((n) => n + 1);
		return true;
	},
};
insightsSelection.set({ kind: "reports", key: report.key });
export function Fixture(props: { debug?: boolean }) {
	return (
		<View class="flex-1">
			<If when={props.debug}>
				<Text>{`Writes: ${count()}`}</Text>
				<Text>{work()}</Text>
				<Action
					label="Refresh fixture"
					onPress={() => snapshot.set({ ...snapshot(), binding: "fixture-refresh" })}
				/>
				<Action
					label="Simulate uncertain change"
					onPress={() => {
						pending.set([{ id: "saved-action", checking: false }]);
						snapshot.set({ ...snapshot(), state: "blocked", canPause: true, canRun: false });
					}}
				/>
			</If>
			<InsightsScreen
				controls={controls}
				openWork={{
					available: () => true,
					wouldReplace: () => false,
					draft: (kind) =>
						work.set(kind === "fix" ? "Fix draft, no work started" : "Mission draft, no work started"),
				}}
			/>
		</View>
	);
}
