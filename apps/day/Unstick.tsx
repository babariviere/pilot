// Unstick: why this mission's planning moves, waits or is stuck, read from what Pilot
// saved, with at most one fix. Reading changes nothing; a fix applies only on Apply.
// When stuck, an agent can look: a read-only chat reads the planner's chat and proposes
// one fix, which also applies only on Apply.

import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { PlanPage } from "pilot-day/native";
import { openChat } from "./chatView";
import { errorText, logEvent } from "./dayLog";
import { openFeedbackWith } from "./feedbackView";
import type { Plans } from "./planning";
import { Action, Mark } from "./ui";

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
	return (
		<If when={u()}>
			<View class="gap-2">
				<View class="-ml-3 flex-row">
					<Action
						testID="unstick"
						label={open() ? "Hide Unstick" : "Unstick"}
						accessibilityLabel="Unstick: why planning moves, waits or is stuck. Reading changes nothing."
						onPress={() => open.set(!open())}
					/>
				</View>
				<If when={open()}>
					<View testID="unstick-card" class="gap-3 rounded-xl bg-muted px-4 py-3">
						<View class="flex-row items-start gap-2.5">
							<View class="pt-1.5">
								<Mark kind={u()?.state === "stuck" ? "needs" : u()?.state === "moving" ? "moving" : "still"} />
							</View>
							<Text testID="unstick-line" class="flex-1 text-sm text-foreground">
								{u()?.line ?? ""}
							</Text>
						</View>
						<If when={u()?.state === "stuck" && u()?.fix !== "none" && !agentProposes()}>
							<View class="gap-2">
								<Text class="text-sm text-muted-foreground">{`Fix: ${FIX_WORDS[(u()?.fix ?? "continue") as keyof typeof FIX_WORDS] ?? ""}`}</Text>
								<View class="-ml-3 flex-row gap-2">
									<Action
										testID="unstick-apply"
										label={busy() ? "Applying…" : "Apply"}
										disabled={busy() || !props.page.fresh}
										onPress={apply}
									/>
									<Action label="Not now" disabled={busy()} onPress={() => open.set(false)} />
								</View>
							</View>
						</If>
						<View class="gap-0.5">
							<Text class="text-xs text-faint">What Pilot checked</Text>
							<Each of={u()?.checks ?? []} key={(line) => line}>
								{(line) => <Text class="text-xs text-faint">{`• ${line()}`}</Text>}
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
							<Text testID="unstick-message" class="text-xs text-faint">
								{message()}
							</Text>
						</If>
					</View>
				</If>
			</View>
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
		<View testID="repair" class="gap-2 border-t border-border pt-3">
			<If when={r()?.state === "looking"}>
				<View class="flex-row items-center gap-2">
					<Text testID="repair-looking" class="flex-1 text-sm text-muted-foreground">
						An agent is looking. This takes about a minute.
					</Text>
					<Action label="Open its chat" onPress={() => openChat(r()?.chatId ?? "", "Plan")} />
				</View>
			</If>
			<If when={r()?.state === "failed"}>
				<Text testID="repair-failed" class="text-sm text-muted-foreground">
					{r()?.reason || "The agent could not look."}
				</Text>
			</If>
			<If when={shown()}>
				<View testID="repair-proposal" class="gap-2">
					<Text class="text-xs text-faint">{`The agent's view · ${p()?.certainty ?? ""} certainty`}</Text>
					<Text testID="repair-cause" class="text-sm text-foreground">
						{p()?.cause ?? ""}
					</Text>
					<Text class="text-sm text-muted-foreground">{REPAIR_WORDS[p()?.fix ?? "none"]}</Text>
					<If when={p()?.fix === "plannerNote"}>
						<Input
							testID="repair-note"
							multiline
							value={note() ?? p()?.note ?? ""}
							onChange={({ value }) => note.set(value)}
							accessibilityLabel="The note to Pilot's planning agent"
							class="min-h-8 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
						/>
					</If>
					<View class="gap-0.5">
						<Text class="text-xs text-faint">What the agent read</Text>
						<Each of={p()?.evidence ?? []} key={(line) => line}>
							{(line) => <Text class="text-xs text-faint">{`• ${line()}`}</Text>}
						</Each>
					</View>
					<If when={!r()?.current}>
						<Text class="text-xs text-faint">The mission changed since the agent looked. Ask again.</Text>
					</If>
					<View class="-ml-3 flex-row gap-2">
						<If when={canApply()}>
							<Action
								testID="repair-apply"
								label={props.busy ? "Applying…" : "Apply"}
								disabled={props.busy || !r()?.current || !props.page.fresh}
								onPress={apply}
							/>
						</If>
						<If when={p()?.fix === "codeRepair"}>
							<Action testID="repair-report" label="Report with Feedback" onPress={report} />
						</If>
						<Action label="Not now" disabled={props.busy} onPress={props.hide} />
						<Action label="Open its chat" onPress={() => openChat(r()?.chatId ?? "", "Plan")} />
					</View>
				</View>
			</If>
			<If when={r()?.available}>
				<View class="-ml-3 flex-row">
					<Action
						testID="repair-start"
						label={r()?.state === "none" ? "Have an agent look" : "Ask an agent again"}
						accessibilityLabel="Start a read-only chat that reads the planner's chat and proposes one fix"
						disabled={props.busy || !props.page.fresh}
						onPress={start}
					/>
				</View>
			</If>
		</View>
	);
}
