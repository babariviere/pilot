// An action only the user can take outside Pilot, such as an upload. It is
// not a decision or an approval: the card says what to do, why Pilot needs
// the user, the exact file and where it goes, and waits for the user's own
// report. Opening the link or the file reports nothing. What the user types
// is kept as a draft for the revision shown; words written before Pilot
// changed the request are shown as history and count only once sent again.
import { cleanup, effect, keymap, signal, Text, View, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import type { ActionAsk, HumanAction } from "pilot-day/native";
import {
	actionNeedsCheck,
	checkAction,
	complete,
	laterAction,
	openLink,
	saveActionDraft,
	saveProgress,
	useEarlier,
} from "./commands";
import { COMMIT_KEY } from "./DecisionCard";
import type { Day } from "./day";
import { Action, InlineAction, Mark } from "./ui";
import { anchors, focusFront, focusInput, messages, reports, reportText, setFor } from "./view";

function verb(asked: ActionAsk | null | undefined): string {
	if (asked === "complete") return "your report";
	if (asked === "later") return "your Later";
	return "your progress";
}

/** One sentence about where the user's last request is, or nothing while idle. */
function deliveryLine(action: HumanAction): string {
	switch (action.delivery) {
		case "sending":
			return `Sending ${verb(action.asked)}…`;
		case "checking":
			return "Checking. This only reads; it changes nothing.";
		case "unknown":
			return `Pilot sent ${verb(action.asked)} but heard nothing back. It will not send it again until it checks.`;
		default:
			return "";
	}
}

/** A quiet label and value pair. */
function Fact(props: { label: string; children: string; testID?: string }) {
	return (
		<View class="flex-row gap-3">
			<Text class="w-20 text-xs text-faint">{props.label}</Text>
			<Text testID={props.testID} class="flex-1 text-sm text-foreground">
				{props.children}
			</Text>
		</View>
	);
}

/** The action `props.action`, `props.index` of `props.count` waiting. */
export function ActionCard(props: { day: Day; action: HumanAction; index: number; count: number }) {
	const a = () => props.action;
	const id = props.action.id;
	const idle = () => a().delivery === "idle";
	const text = () => reportText(a());
	const input = signal<ViewRef | null>(null);
	let stopEscape: (() => void) | null = null;

	let laterButton: ViewRef | undefined;

	// The keyboard focus lands on Later, not in the report: J and K keep
	// working, and nothing is reported by a stray key.
	anchors.set(id, () => laterButton);
	cleanup(() => {
		anchors.delete(id);
		stopEscape?.();
		// Leaving the card saves its words now rather than after the pause.
		props.day.feed.flushDrafts();
	});
	effect(() => {
		if (focusFront() && laterButton) {
			laterButton.focus();
			focusFront.set(false);
		}
	});
	effect(() => {
		const field = input();
		if (focusInput() === id && field) {
			field.focus();
			focusInput.set(null);
		}
	});
	const leave = () => {
		input()?.blur();
		laterButton?.focus();
	};
	const meta = () =>
		[a().origin.missionTitle || a().origin.chatTitle, a().effort]
			.filter(Boolean)
			.map((part) => `· ${part}`)
			.join(" ");

	return (
		<View testID="action" class="gap-4 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<View class="gap-2">
				<Text role="header" class="text-xl font-semibold leading-snug text-card-foreground">
					{a().title}
				</Text>
				<View class="flex-row flex-wrap items-center gap-1.5">
					<Mark kind={a().delivery === "unknown" ? "unknown" : "needs"} />
					<Text class="text-xs text-needs-ink">
						{a().state === "deferred" ? "Action for you · put off" : "Action for you"}
					</Text>
					<Text class="text-xs text-muted-foreground">{meta()}</Text>
					<View class="flex-1" />
					<If when={props.count > 1}>
						<Text class="text-xs text-faint">{`${props.index + 1} of ${props.count}`}</Text>
					</If>
				</View>
			</View>

			<If when={a().replaced}>
				<Text role="alert" class="text-sm text-needs-ink">
					{a().replaced ?? ""}
				</Text>
			</If>

			<View class="gap-1.5">
				<If when={a().nextStep}>
					<Text class="text-sm font-medium text-card-foreground">{a().nextStep}</Text>
				</If>
				<Text class="text-sm leading-relaxed text-muted-foreground">{a().why}</Text>
			</View>

			<View selectable class="gap-2 rounded-xl bg-muted px-4 py-3">
				<Each of={a().files} key={(f) => `${f.name}\u0000${f.digest}`}>
					{(f) => (
						<Fact
							label="File"
							testID="action-file"
						>{`${f().name} · version ${f().version} · ${f().digest}`}</Fact>
					)}
				</Each>
				<Fact label="Where">{`${a().destination.target} on ${a().destination.label}`}</Fact>
				<Fact label="Link">{a().destination.link}</Fact>
				<If when={a().canOpen}>
					<View class="flex-row gap-3">
						<View class="w-20" />
						<InlineAction testID="open-link" label="Open link" onPress={() => void openLink(props.day, a())} />
					</View>
				</If>
				<Fact label="Asked by">{`“${a().origin.chatTitle}” · ${a().origin.chatLink}`}</Fact>
			</View>

			<If when={a().progress}>
				<Text class="text-sm text-muted-foreground">{`Saved progress: ${a().progress}`}</Text>
			</If>

			<If when={a().earlierReport}>
				<View class="gap-1">
					<Text class="text-xs text-faint">
						Your words from before Pilot changed the request. They do not count as a report.
					</Text>
					<View class="flex-row flex-wrap items-baseline gap-x-1.5">
						<Text testID="earlier-report" class="text-sm text-muted-foreground">
							{a().earlierReport ?? ""}
						</Text>
						<If when={idle()}>
							<InlineAction
								testID="use-earlier"
								label="Use these words"
								onPress={() => useEarlier(props.day, a())}
							/>
						</If>
					</View>
				</View>
			</If>

			<View class="gap-1.5">
				<Text class="text-xs text-muted-foreground">
					{a().needs.length > 0
						? `When it is done, tell Pilot: ${a().needs.join("; ")}.`
						: "Tell Pilot when it is done."}
				</Text>
				<Input
					testID="report"
					ref={(node) => input.set(node)}
					value={text()}
					onChange={({ value }) => {
						setFor(reports, id, value);
						saveActionDraft(props.day, a());
					}}
					onFocus={() => {
						stopEscape?.();
						stopEscape = keymap.bind("escape", leave, { when: "always" });
					}}
					onBlur={() => {
						stopEscape?.();
						stopEscape = null;
						props.day.feed.flushDrafts();
					}}
					placeholder={a().needs[0] ?? "What you did"}
					class="min-h-8 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
				/>
				<Text class="text-xs text-faint">Opening the link or the file does not count. Only your report does.</Text>
			</View>

			<If when={a().draft.unsaved}>
				<Text role="alert" class="text-sm text-needs-ink">
					Pilot could not save these words. They stay here; copy them before you close Pilot.
				</Text>
			</If>
			<If when={deliveryLine(a())}>
				<Text role="alert" class="text-sm text-muted-foreground">
					{deliveryLine(a())}
				</Text>
			</If>
			<If when={messages()[id]}>
				<Text role="alert" class="text-sm text-needs-ink">
					{messages()[id] ?? ""}
				</Text>
			</If>

			<View class="flex-row flex-wrap items-center gap-2">
				<If
					when={actionNeedsCheck(a())}
					else={
						<Action
							primary
							label="Mark done"
							shortcut={COMMIT_KEY}
							disabled={!idle() || (a().needs.length > 0 && text().trim() === "")}
							onPress={() => void complete(props.day, a())}
						/>
					}
				>
					<Action
						primary
						label="Check again"
						shortcut={COMMIT_KEY}
						disabled={a().delivery === "checking"}
						onPress={() => void checkAction(props.day, a())}
					/>
				</If>
				<Action
					label="Save progress"
					disabled={!idle() || text().trim() === ""}
					onPress={() => void saveProgress(props.day, a())}
				/>
				<Action
					label="Later"
					shortcut="L"
					anchor={(node) => {
						laterButton = node;
					}}
					disabled={!idle()}
					onPress={() => void laterAction(props.day, a())}
				/>
				<View class="flex-1" />
				<Text class="text-xs text-faint">{`${COMMIT_KEY} Mark done · J K next`}</Text>
			</View>
		</View>
	);
}
