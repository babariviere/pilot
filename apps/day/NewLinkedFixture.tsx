// Isolated fixture: a linked mission draft from Feedback in New, beside an
// existing New draft. Mock data. No service, provider or real creation.
import { mount, signal, Text, View } from "nsh";
import type { NewIntent, PlanOutcome } from "pilot-day/native";
import type { ScriptedChats } from "./chatDemo";
import type { PlanningFeed } from "./feeds";
import type { FeedbackItem } from "./feedbackFeed";
import type { ChatStep } from "./feedbackSteps";
import { feedbackOpen } from "./feedbackView";
import { draftLinkedMission } from "./linkedMission";
import { MissionScreen } from "./MissionScreen";
import { openDay, openPlanning } from "./mockFeeds";
import { NewScreen } from "./NewScreen";
import {
	capturePlanningDraft,
	chatPick,
	goalDraft,
	linkedMission,
	openNew,
	planRoute,
	requestDraft,
	resetPlanningView,
	restorePlanningDraft,
} from "./planView";
import { Action } from "./ui";

const plans = openPlanning("fresh");
const original = plans.feed;
const chats = plans.chats.source as ScriptedChats;
const DIGEST = "d".repeat(64);
const item = {
	id: "feedback-1",
	sequence: 1,
	text: "Exported chat names collide",
	origin: null,
	recordedAt: 1,
	operationId: "feedback-op",
	work: [],
} as FeedbackItem;
const triage = {
	kind: "triage",
	operationId: "triage-op",
	recordedAt: 2,
	sessionId: "triage-1",
	projectId: "demo-pilot",
} as ChatStep;
const proposal = {
	value: {
		summary: "Exports overwrite each other",
		duplicates: [],
		next: "new-mission" as const,
		detail: "Decide how duplicate filenames work.",
		missionId: null,
		goal: "Prevent overwrites across all chat export formats",
	},
	digest: DIGEST,
};

const another = { ...item, id: "feedback-2", text: "Exports lose their images" } as FeedbackItem;
const anotherProposal = {
	value: { ...proposal.value, goal: "Keep images in chat exports" },
	digest: "e".repeat(64),
};
const day = openDay();
const missionShown = signal(false);

/** What the next Plan answers: accepted, rejected or unknown. */
const next = signal<"accepted" | "rejected" | "unknown">("rejected");
const sent = signal<NewIntent[]>([]);
const checks = signal(0);
const result = (status: PlanOutcome["status"], message: string, missionId: string | null = null): PlanOutcome => ({
	status,
	revision: 0,
	message,
	missionId,
});
const feed: PlanningFeed = {
	snapshot: () => plans.planning(),
	onChange: (cb) => original.onChange(cb),
	page: (id) => original.page(id),
	open: (id) => original.open(id),
	start: (intent) => original.start(intent),
	saveAnswer: (intent) => original.saveAnswer(intent),
	submit: (intent) => original.submit(intent),
	checkSubmit: (intent) => original.checkSubmit(intent),
	dispose: () => original.dispose(),
	canCheckNew: () => (plans.planning().setup.creations ?? []).length > 0,
	checkNew: async (operationId) => {
		checks.set(checks() + 1);
		plans.planning.update((p) => ({ ...p, setup: { ...p.setup, unconfirmed: false, creations: [] } }));
		return result("accepted", `Checked ${operationId}. Nothing was sent again.`, "m-linked");
	},
	plan: async (intent) => {
		sent.set([...sent(), intent]);
		const status = next();
		if (status === "unknown")
			plans.planning.update((p) => ({
				...p,
				setup: {
					...p.setup,
					unconfirmed: true,
					creations: [
						{
							operationId: "linked-op",
							goal: intent.goal,
							projectId: "demo-pilot",
							feedback: intent.feedback ?? null,
						},
					],
				},
			}));
		return status === "accepted"
			? result("accepted", "Mission created.", "m-linked")
			: status === "unknown"
				? result("unknown", "No exact acknowledgement. Check; do not resend.")
				: result("rejected", "The suggestion changed since you read it. Read it again in Feedback.");
	},
};

// New already holds the user's own draft: its words, project, mode and request.
goalDraft.set("Add keyboard shortcuts for the command palette");
chatPick.set({ projectId: "demo-website", mode: "ask" });
requestDraft.set({ itemId: "slack-1", revision: 2, title: "Shortcuts please", source: "Slack" });

const last = () => sent().at(-1);
mount(() => (
	<View class="flex-1">
		<Text>Mock data · Linked mission from Feedback</Text>
		<View class="flex-row flex-wrap gap-2">
			<Action label="Draft a linked mission" onPress={() => draftLinkedMission(item, triage, proposal)} />
			<Action
				label="Draft another suggestion"
				onPress={() => draftLinkedMission(another, { ...triage, sessionId: "triage-2" }, anotherProposal)}
			/>
			<Action label="Open New" onPress={openNew} />
			<Action
				label="Show Docs mission"
				onPress={() => {
					planRoute.set(null);
					missionShown.set(true);
				}}
			/>
			<Action label="Next accepted" onPress={() => next.set("accepted")} />
			<Action label="Next unknown" onPress={() => next.set("unknown")} />
			<Action
				label="Older receipt with the same words"
				onPress={() =>
					plans.planning.update((p) => ({
						...p,
						setup: {
							...p.setup,
							unconfirmed: true,
							creations: [{ operationId: "older-op", goal: goalDraft(), projectId: "demo-pilot" }],
						},
					}))
				}
			/>
			<Action
				label="Close and restore window"
				onPress={() => {
					const saved = capturePlanningDraft();
					resetPlanningView();
					restorePlanningDraft(saved);
					openNew();
				}}
			/>
		</View>
		<Text testID="linked-state">{`Draft: [${goalDraft().split("\n")[0]}] · ${chatPick()?.projectId ?? "none"}/${chatPick()?.mode ?? "none"} · request ${requestDraft()?.itemId ?? "none"} · linked ${linkedMission() ? "yes" : "no"}`}</Text>
		<Text testID="linked-sent">{`Plans: ${sent().length} · Checks: ${checks()}`}</Text>
		<Text>{`Chats started: ${chats.counts().sends}`}</Text>
		<Text testID="linked-intent">{`Sent: ${last() ? JSON.stringify({ goal: last()!.goal.split("\n")[0], feedback: last()!.feedback, request: last()!.request, replaces: last()!.replaces }) : "none"}`}</Text>
		<Text testID="linked-route">{`Route: ${planRoute()?.kind ?? "closed"}${planRoute()?.kind === "plan" ? `/${(planRoute() as { missionId: string }).missionId}` : ""} · Feedback ${feedbackOpen() ? "open" : "closed"}`}</Text>
		<If when={missionShown() && !planRoute()}>
			<MissionScreen day={day} missionId="docs" />
		</If>
		<If when={planRoute()?.kind === "new"}>
			<NewScreen plans={{ ...plans, feed }} />
		</If>
	</View>
));
