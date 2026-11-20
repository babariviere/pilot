// MOCKUP. Mock data only: a feedback item whose triage proposed a prototype. No daemon, files or effects.
// Run from the repository root: apps/day/nsh.sh run fixtures/feedback-prototype/FeedbackPrototypeMockup.tsx
// The tabs walk one item through its states: the prototype proposal, the prototype's question with its
// mockups, and the fix built from the user's choice. Choosing here sends nothing.
import { mount, Scroll, signal, Text, View } from "nsh";
import type { DecisionArtifact } from "pilot-day/native";
import { createShelf, PinnedArtifacts } from "../../ArtifactShelf";
import type { ArtifactRow, ArtifactSource, ListResult, ReadResult } from "../../artifactReads";
import { FeedbackQuestion } from "../../FeedbackQuestion";
import type { FeedbackItem, StepResult, UserFeedbackQuestion } from "../../feedbackFeed";
import type { ChatStep } from "../../feedbackSteps";
import { QuestionArtifacts } from "../../QuestionArtifacts";
import { Action, MarkLine, QuietPanel, TabItem, TabRow } from "../../ui";

type State = "proposal" | "question" | "fix";
const state = signal<State>("question");
const said = signal("");

const PROTOTYPE = "chat-prototype";
const mockups: DecisionArtifact[] = [
	{ sessionId: PROTOTYPE, artifactId: "m-chips", title: "Inline owner chips", kind: "nsh", revision: 2 },
	{ sessionId: PROTOTYPE, artifactId: "m-column", title: "Owner column", kind: "nsh", revision: 1 },
	{ sessionId: PROTOTYPE, artifactId: "m-hover", title: "Owner on hover", kind: "nsh", revision: 1 },
];
const source: ArtifactSource = {
	async list(): Promise<ListResult> {
		return { ok: true, list: { rows: [], more: false } };
	},
	async read(row: ArtifactRow): Promise<ReadResult> {
		const text = `// ${row.title}\nexport default () => <Text>Plan rows with owners</Text>;`;
		return {
			status: "shown",
			artifact: {
				version: 1,
				reference: { sourceSessionId: row.sessionId, artifactId: row.artifactId, revision: row.revision ?? 0 },
				metadata: { title: row.title, kind: row.kind },
				rendering: "unsupported",
				content: { state: "text", source: text, containerSha256: "a".repeat(64), containerBytes: text.length },
			},
		};
	},
};

const item = {
	id: "f1",
	text: "Plan rows feel crowded. I cannot tell who owns which task.",
	origin: null,
	recordedAt: 0,
	operationId: "op-f1",
	sequence: 1,
	work: [],
} as FeedbackItem;
const prototypeStep = {
	kind: "prototype",
	operationId: "op-p",
	recordedAt: 0,
	sessionId: PROTOTYPE,
	projectId: "pilot",
	triageSessionId: "chat-triage",
	proposalDigest: "d".repeat(64),
	chat: { title: "Prototype: Plan rows feel crowded", state: "question" },
} as unknown as ChatStep;
const question: UserFeedbackQuestion = {
	id: 7,
	question: "Which one should Pilot build?",
	context: "Each mockup is the plan page with mock tasks. They differ only in where the owner shows.",
	options: [
		{ label: "Inline owner chips", detail: "A small chip after each task title.", suggested: true },
		{ label: "Owner column", detail: "A right-aligned column, like a table." },
		{ label: "Owner on hover", detail: "Quiet rows; the owner shows when you point at a row." },
	],
};

function Line(props: { kind: "moving" | "needs" | "ready"; text: string; chat?: string }) {
	return (
		<View class="gap-1.5">
			<MarkLine kind={props.kind}>
				<Text class="text-sm leading-relaxed text-foreground">{props.text}</Text>
			</MarkLine>
			<If when={props.chat}>
				<View class="flex-row pl-4.5">
					<Action label={props.chat ?? ""} />
				</View>
			</If>
		</View>
	);
}

function PrototypeProposal() {
	return (
		<QuietPanel class="gap-2.5">
			<Text class="text-xs font-medium text-muted-foreground">Proposed: try a prototype first</Text>
			<Text class="text-sm leading-relaxed text-foreground">
				The look of a task's owner on plan rows is unclear.
			</Text>
			<Text class="text-sm leading-relaxed text-muted-foreground">
				Explore where a plan row shows who works on the task, without making rows taller.
			</Text>
			<View class="gap-1">
				<Text class="text-xs text-faint">Directions to mock up</Text>
				<Text class="text-sm text-foreground">1. Inline owner chips after the title</Text>
				<Text class="text-sm text-foreground">2. A right-aligned owner column</Text>
				<Text class="text-sm text-foreground">3. Owner on hover only</Text>
			</View>
			<View class="flex-row flex-wrap items-center gap-2">
				<Action variant="outline" label="Start prototype" onPress={() => state.set("question")} />
				<Action label="Start fix" />
			</View>
			<Text class="text-xs text-faint">A prototype makes mockups to choose from. It writes no code.</Text>
		</QuietPanel>
	);
}

function ChosenFix() {
	const shelf = createShelf();
	const chosen = mockups[0]!;
	return (
		<QuietPanel class="gap-2.5">
			<Text class="text-xs font-medium text-muted-foreground">Proposed: a small fix, from your choice</Text>
			<Text class="text-sm leading-relaxed text-foreground">Inline owner chips on plan rows.</Text>
			<Text class="text-sm leading-relaxed text-muted-foreground">
				Add an owner chip after each task title in PlanRow, as in the chosen mockup. Check it in Plan.test.tsx.
			</Text>
			<View class="gap-2">
				<Text class="text-xs text-muted-foreground">The mockup you chose:</Text>
				<PinnedArtifacts source={source} shelf={shelf} rows={[{ ...chosen, pinned: true, updatedAt: 0 }]} />
			</View>
			<View class="flex-row flex-wrap items-center gap-2">
				<Action variant="outline" label="Start fix" />
			</View>
		</QuietPanel>
	);
}

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row items-center gap-4 px-6 py-3">
			<Text class="text-xs text-faint">Mockup. Mock data.</Text>
			<TabRow>
				<TabItem label="1. Proposal" selected={state() === "proposal"} onPress={() => state.set("proposal")} />
				<TabItem
					label="2. Choose a mockup"
					selected={state() === "question"}
					onPress={() => state.set("question")}
				/>
				<TabItem label="3. Fix from choice" selected={state() === "fix"} onPress={() => state.set("fix")} />
			</TabRow>
		</View>
		<Scroll class="flex-1">
			<View class="mx-auto w-full max-w-3xl gap-2.5 border-t border-border px-6 py-3">
				<View class="gap-1">
					<Text class="text-sm leading-relaxed text-foreground">{item.text}</Text>
					<Text class="text-xs text-faint">9 Nov</Text>
				</View>
				<If when={state() === "proposal"}>
					<PrototypeProposal />
				</If>
				<If when={state() === "question"}>
					<Line kind="needs" text="The prototype needs your choice." chat="Open the prototype chat" />
					<QuestionArtifacts source={source} artifacts={mockups} />
					<FeedbackQuestion
						item={item}
						triage={prototypeStep}
						question={question}
						busy={false}
						sending={false}
						send={async (intent): Promise<StepResult> => {
							said.set("message" in intent ? intent.message : "");
							state.set("fix");
							return { status: "accepted", message: "" };
						}}
						check={async () => {}}
					/>
				</If>
				<If when={state() === "fix"}>
					<Line kind="ready" text="The prototype finished with your choice." chat="Open the prototype chat" />
					<If when={said()}>
						<Text class="text-xs text-muted-foreground">{`You answered: “${said()}”`}</Text>
					</If>
					<ChosenFix />
				</If>
				<View class="flex-row flex-wrap items-center gap-2">
					<Action label="Mark resolved" />
					<Action label="Remove" />
				</View>
			</View>
		</Scroll>
	</View>
));
