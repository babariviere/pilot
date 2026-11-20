// Unstick: why this mission's planning moves, waits or is stuck, read from what Pilot
// saved, with at most one fix. Reading changes nothing; a fix applies only on Apply.
// When stuck, an agent can look: a read-only chat reads the planner's chat and proposes
// one fix, which also applies only on Apply.

import { signal, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { openChat } from "./chatView";
import { errorText, logEvent } from "./dayLog";
import { openFeedbackWith } from "./feedbackView";
import { OpenChatAction } from "./OpenChatAction";
import type { Plans } from "./planning";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Disclosure,
	Mark,
	type MarkKind,
	Question,
	Quote,
	State,
	TextField,
} from "./ui";

type Repair = NonNullable<NonNullable<PlanPage["unstick"]>["repair"]>;
type Fix = NonNullable<Repair["proposal"]>["fix"];

const FIX_WORDS = {
	continue: "Continue planning: Pilot's planning agent picks up where it stopped.",
	dropEarlierAnswers: "Remove the saved answers to the earlier wording. Answer those questions again after.",
} as const;

const REPAIR_WORDS: Record<Fix, string> = {
	continue: "Continue planning: Pilot's planning agent picks up where it stopped.",
	plannerNote: "Continue planning with this note to Pilot's planning agent. You can change it first.",
	dropEarlierAnswers: "Remove the saved answers to the earlier wording. Answer those questions again after.",
	codeRepair: "Pilot's code needs a fix. Report it with Feedback: there you can start a fix in Pilot's project.",
	none: "Nothing to apply from here.",
};

/** Whether the planner ended its turn while the plan is open, and may wait for a reply in prose. */
export function plannerWaits(page: PlanPage): boolean {
	return page.unstick?.state === "stuck" && page.unstick.reply === true;
}

/**
 * The planner ended its turn with no question while the plan is open: its last words, a reply field and the two
 * ways on. Reply sends the user's words as a note it reads; Continue sends none. Each is sent once, on a press.
 */
export function PlannerWaits(props: { plans: Plans; page: PlanPage }) {
	const reply = signal("");
	const busy = signal(false);
	const message = signal("");
	const u = () => props.page.unstick;
	const send = async (note: string) => {
		const feed = props.plans.feed;
		if (busy() || !feed.continuePlanning) return;
		busy.set(true);
		message.set("");
		try {
			// Called on the feed: the connected feed's methods use their own private state.
			const outcome = await feed.continuePlanning({ missionId: props.page.missionId, feedback: "", note });
			message.set(outcome.message);
			if (outcome.status === "accepted") reply.set("");
		} catch (error) {
			logEvent("ui.error", errorText(error));
			message.set("Pilot could not send this. Nothing was sent.");
		} finally {
			busy.set(false);
		}
	};
	const ready = () => !busy() && props.page.fresh && props.page.canContinue;
	return (
		<If when={plannerWaits(props.page) || message()}>
			<View testID="planner-waits">
				<If when={plannerWaits(props.page)}>
					{/* The planner waits for the user's words: a Question, with Reply and Continue in its foot. */}
					<Question
						title={u()?.line ?? ""}
						titleTestID="planner-waits-line"
						meta={<State kind="needs" plain />}
						foot={
							<>
								<Button
									testID="planner-reply-send"
									label={busy() ? "Sending…" : "Reply"}
									disabled={!ready() || !reply().trim()}
									accessibilityLabel="Send your reply to Pilot's planning agent. Sent once. It answers no interview question."
									onPress={() => void send(reply())}
								/>
								<Button
									testID="planner-continue"
									label="Continue"
									disabled={!ready()}
									accessibilityLabel="Continue planning with no reply. Pilot's planning agent picks up where it stopped."
									onPress={() => void send("")}
								/>
							</>
						}
					>
						<If when={u()?.plannerSays}>
							<View class="gap-1">
								<Caption tone="faint">Its last message</Caption>
								<Quote testID="planner-says" text={u()?.plannerSays ?? ""} />
							</View>
						</If>
						<TextField
							testID="planner-reply"
							multiline
							rows={3}
							value={reply()}
							onChange={({ value }) => reply.set(value)}
							accessibilityLabel="Your reply to Pilot's planning agent. It reads it as a note and continues."
						/>
					</Question>
				</If>
				<If when={message()}>
					<Block>
						<Caption testID="planner-waits-message" tone="faint">
							{message()}
						</Caption>
					</Block>
				</If>
			</View>
		</If>
	);
}

/** The Unstick action under the planner's status, and its card once opened. */
export function Unstick(props: { plans: Plans; page: PlanPage }) {
	const open = signal(false);
	const busy = signal(false);
	const message = signal("");
	// The repair state a message was written in: a newer state replaces it.
	const messageFor = signal<string | undefined>(undefined);
	const u = () => props.page.unstick;
	// The repair chat whose proposal the user put aside with Not now.
	const hidden = signal("");
	// One fix at a time: the agent's proposal, while shown, replaces the rule's fix.
	const agentProposes = () => u()?.repair?.state === "proposed" && hidden() !== u()?.repair?.chatId;
	// Calls run on the feed: the connected feed's methods use their own private state.
	const run = async (send: () => Promise<{ message: string } | undefined> | undefined) => {
		if (busy()) return;
		busy.set(true);
		message.set("");
		try {
			const outcome = await send();
			message.set(outcome?.message ?? "This is not available here. Nothing was sent.");
			messageFor.set(props.page.unstick?.repair?.state);
		} catch (error) {
			logEvent("ui.error", errorText(error));
			message.set("Pilot could not do this. Nothing was sent.");
		} finally {
			busy.set(false);
		}
	};
	const apply = () => {
		const feed = props.plans.feed;
		const fix = u()?.fix;
		const missionId = props.page.missionId;
		if (!fix || fix === "none") return;
		void run(() =>
			fix === "continue"
				? feed.continuePlanning?.({ missionId, feedback: "" })
				: feed.dropEarlierAnswers?.({ missionId }),
		);
	};
	// Stuck needs the user; moving is work going on; waiting is quiet.
	const mark = (): MarkKind => (u()?.state === "stuck" ? "needs" : u()?.state === "moving" ? "working" : "new");
	return (
		<If when={u()}>
			<Block>
				<Disclosure
					testID="unstick"
					label={open() ? "Hide Unstick" : "Unstick"}
					accessibilityLabel="Unstick: why planning moves, waits or is stuck. Reading changes nothing."
					open={open()}
					onToggle={() => open.set(!open())}
				>
					<View testID="unstick-card" class="gap-3">
						<View class="flex-row items-start gap-2">
							<Mark kind={mark()} />
							<Body testID="unstick-line" grow>
								{u()?.line ?? ""}
							</Body>
						</View>
						<If when={u()?.state === "stuck" && u()?.fix !== "none" && !agentProposes()}>
							<View class="gap-2">
								<Body tone="muted">{`Fix: ${FIX_WORDS[(u()?.fix ?? "continue") as keyof typeof FIX_WORDS] ?? ""}`}</Body>
								<Buttons>
									<Button
										testID="unstick-apply"
										label={busy() ? "Applying…" : "Apply"}
										disabled={busy() || !props.page.fresh}
										onPress={apply}
									/>
									<Button label="Not now" disabled={busy()} onPress={() => open.set(false)} />
								</Buttons>
							</View>
						</If>
						<View class="gap-0.5">
							<Caption tone="faint">What Pilot checked</Caption>
							<Each of={u()?.checks ?? []} key={(line) => line}>
								{(line) => <Caption tone="faint">{`• ${line()}`}</Caption>}
							</Each>
						</View>
						<If when={u()?.repair?.available || (u()?.repair && u()?.repair?.state !== "none")}>
							<RepairAgent
								plans={props.plans}
								page={props.page}
								busy={busy()}
								run={run}
								shown={agentProposes()}
								hide={() => hidden.set(u()?.repair?.chatId ?? "")}
							/>
						</If>
						<If when={message() && messageFor() === u()?.repair?.state}>
							<Caption testID="unstick-message" tone="faint">
								{message()}
							</Caption>
						</If>
					</View>
				</Disclosure>
			</Block>
		</If>
	);
}

/** The repair agent: start it, follow it, and apply its one fix. */
function RepairAgent(props: {
	plans: Plans;
	page: PlanPage;
	busy: boolean;
	run: (send: () => Promise<{ message: string } | undefined> | undefined) => Promise<void>;
	/** Whether the proposal shows (not put aside with Not now). */
	shown: boolean;
	hide: () => void;
}) {
	const r = () => props.page.unstick?.repair;
	const p = () => r()?.proposal;
	// The note as the user edited it; null until they do. An empty note keeps the agent's.
	const note = signal<string | null>(null);
	const shown = () => !!p() && props.shown;
	const missionId = () => props.page.missionId;
	const start = () => void props.run(() => props.plans.feed.repairStart?.({ missionId: missionId() }));
	const apply = () =>
		void props.run(() => props.plans.feed.repairApply?.({ missionId: missionId(), note: note() ?? "" }));
	const canApply = () => !!p() && ["continue", "plannerNote", "dropEarlierAnswers"].includes(p()!.fix);
	// A bug in Pilot itself goes to Feedback, where the user can start a fix in Pilot's own project.
	const report = () =>
		openFeedbackWith(
			{ kind: "mission", missionId: missionId() },
			[
				"Planning for this mission got stuck, and Pilot's repair agent says Pilot's code needs a fix.",
				"",
				`Cause: ${p()?.cause ?? ""}`,
				"",
				"What the agent read:",
				...(p()?.evidence ?? []).map((e) => `- ${e}`),
				"",
				`Repair chat: pilot://chat/${r()?.chatId ?? ""}`,
			].join("\n"),
		);
	return (
		<View testID="repair" class="gap-2">
			<If when={r()?.state === "looking"}>
				<View class="flex-row items-start gap-2">
					<Body testID="repair-looking" tone="muted" grow>
						An agent is looking. This takes about a minute.
					</Body>
					<OpenChatAction
						label="Open planning repair chat"
						accessibilityLabel="Open planning repair chat"
						onPress={() => openChat(r()?.chatId ?? "", "Plan")}
					/>
				</View>
			</If>
			<If when={r()?.state === "failed"}>
				<Body testID="repair-failed" tone="muted">
					{r()?.reason || "The agent could not look."}
				</Body>
			</If>
			<If when={shown()}>
				<View testID="repair-proposal" class="gap-2">
					<View class="flex-row items-start gap-3">
						<Caption tone="faint" grow>{`The agent's view · ${p()?.certainty ?? ""} certainty`}</Caption>
						<OpenChatAction
							label="Open planning repair chat"
							accessibilityLabel="Open planning repair chat"
							onPress={() => openChat(r()?.chatId ?? "", "Plan")}
						/>
					</View>
					<Body testID="repair-cause">{p()?.cause ?? ""}</Body>
					<Body tone="muted">{REPAIR_WORDS[p()?.fix ?? "none"]}</Body>
					<If when={p()?.fix === "plannerNote"}>
						<TextField
							testID="repair-note"
							multiline
							rows={3}
							value={note() ?? p()?.note ?? ""}
							onChange={({ value }) => note.set(value)}
							accessibilityLabel="The note to Pilot's planning agent"
						/>
					</If>
					<View class="gap-0.5">
						<Caption tone="faint">What the agent read</Caption>
						<Each of={p()?.evidence ?? []} key={(line) => line}>
							{(line) => <Caption tone="faint">{`• ${line()}`}</Caption>}
						</Each>
					</View>
					<If when={!r()?.current}>
						<Caption tone="faint">The mission changed since the agent looked. Ask again.</Caption>
					</If>
					<Buttons>
						<If when={canApply()}>
							<Button
								testID="repair-apply"
								label={props.busy ? "Applying…" : "Apply"}
								disabled={props.busy || !r()?.current || !props.page.fresh}
								onPress={apply}
							/>
						</If>
						<If when={p()?.fix === "codeRepair"}>
							<Button testID="repair-report" label="Report with Feedback" onPress={report} />
						</If>
						<Button label="Not now" disabled={props.busy} onPress={props.hide} />
					</Buttons>
				</View>
			</If>
			<If when={r()?.available}>
				<Buttons>
					<Button
						testID="repair-start"
						label={r()?.state === "none" ? "Have an agent look" : "Ask an agent again"}
						accessibilityLabel="Start a read-only chat that reads the planner's chat and proposes one fix"
						disabled={props.busy || !props.page.fresh}
						onPress={start}
					/>
				</Buttons>
			</If>
		</View>
	);
}
