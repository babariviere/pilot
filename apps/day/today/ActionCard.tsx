// An action only the user can take outside Pilot, such as an upload. It is
// not a decision or an approval: the card says what to do, why Pilot needs
// the user, the exact file and where it goes, and waits for the user's own
// report. Opening the link or the file reports nothing. What the user types
// is kept as a draft for the revision shown; words written before Pilot
// changed the request are shown as history and count only once sent again.
import { cleanup, effect, keymap, signal, View, type ViewRef } from "nsh";
import type { ActionAsk, HumanAction } from "pilot-day/native";
import type { Day } from "../app/day";
import { keepField } from "../app/kept";
import { anchors, focusFront, focusInput, holdFront, messages, reports, reportText, setFor } from "../app/view";
import {
	Body,
	BodyStrong,
	Button,
	Caption,
	Fact,
	Facts,
	KeyHints,
	Link,
	Question,
	Spacer,
	State,
	TextField,
} from "../ui";
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
			return `Checking that ${verb(action.asked)} arrived…`;
		case "unknown":
			return `Pilot could not confirm ${verb(action.asked)} yet. It will not send it again. Check again only reads.`;
		default:
			return "";
	}
}

/** A quiet label and value pair. */
/** The action `props.action`, `props.index` of `props.count` waiting. */
export function ActionCard(props: { day: Day; action: HumanAction; index: number; count: number }) {
	const a = () => props.action;
	const id = props.action.id;
	const idle = () => a().delivery === "idle";
	const text = () => reportText(a());
	const input = signal<ViewRef | null>(null);
	// The report keeps its focus and selection for an update's saved view.
	const reportField = keepField(
		`report:${id}`,
		() => "today",
		text,
		(node) => input.set(node),
	);
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
		<Question
			testID="action"
			title={a().title}
			position={props.count > 1 ? `${props.index + 1} of ${props.count}` : undefined}
			meta={
				<>
					<State
						kind={a().delivery === "unknown" ? "unconfirmed" : "needs"}
						label={a().state === "deferred" ? "Action for you · put off" : "Action for you"}
						plain
					/>
					<Caption>{meta()}</Caption>
				</>
			}
			foot={
				<>
					<If
						when={actionNeedsCheck(a())}
						else={
							<Button
								kind="primary"
								label="Mark done"
								shortcut={COMMIT_KEY}
								disabled={!idle() || (a().needs.length > 0 && text().trim() === "")}
								onPress={() => void complete(props.day, a())}
							/>
						}
					>
						{/* Pilot checks by itself first; the button is the fallback after its tries. */}
						<If when={a().delivery === "unknown"}>
							<Button
								kind="primary"
								label="Check again"
								shortcut={COMMIT_KEY}
								onPress={() => void checkAction(props.day, a())}
							/>
						</If>
					</If>
					<Button
						label="Save progress"
						disabled={!idle() || text().trim() === ""}
						onPress={() => void saveProgress(props.day, a())}
					/>
					<Button
						label="Later"
						shortcut="L"
						anchor={(node) => {
							laterButton = node;
						}}
						disabled={!idle()}
						onPress={() => void laterAction(props.day, a())}
					/>
					<Spacer />
					<KeyHints
						hints={[
							[COMMIT_KEY, "Mark done"],
							["J K", "next"],
						]}
					/>
				</>
			}
		>
			<If when={a().replaced}>
				<Body role="alert" tone="needs">
					{a().replaced ?? ""}
				</Body>
			</If>

			<View class="gap-1.5">
				<If when={a().nextStep}>
					<BodyStrong>{a().nextStep}</BodyStrong>
				</If>
				<Body tone="muted" measure>
					{a().why}
				</Body>
			</View>

			<Facts>
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
					<Fact label="">
						<Link testID="open-link" label="Open link" onPress={() => void openLink(props.day, a())} />
					</Fact>
				</If>
				<Fact label="Asked by">{`“${a().origin.chatTitle}” · ${a().origin.chatLink}`}</Fact>
			</Facts>

			<If when={a().progress}>
				<Body tone="muted">{`Saved progress: ${a().progress}`}</Body>
			</If>

			<If when={a().earlierReport}>
				<View class="gap-1">
					<Caption tone="faint">
						Your words from before Pilot changed the request. They do not count as a report.
					</Caption>
					<Body testID="earlier-report" tone="muted">
						{a().earlierReport ?? ""}
					</Body>
					<If when={idle()}>
						<Link testID="use-earlier" label="Use these words" onPress={() => useEarlier(props.day, a())} />
					</If>
				</View>
			</If>

			<View class="gap-1.5">
				<Caption>
					{a().needs.length > 0
						? `When it is done, tell Pilot: ${a().needs.join("; ")}.`
						: "Tell Pilot when it is done."}
				</Caption>
				<TextField
					testID="report"
					ref={reportField.ref}
					value={text()}
					onChange={({ value }) => {
						setFor(reports, id, value);
						saveActionDraft(props.day, a());
					}}
					onFocus={() => {
						holdFront(id);
						reportField.focus();
						stopEscape?.();
						stopEscape = keymap.bind("escape", leave, { when: "always" });
					}}
					onSelectionChange={reportField.select}
					onBlur={() => {
						stopEscape?.();
						stopEscape = null;
						props.day.feed.flushDrafts();
					}}
					placeholder={a().needs[0] ?? "What you did"}
				/>
				<Caption tone="faint">Opening the link or the file does not count. Only your report does.</Caption>
			</View>

			<If when={a().draft.unsaved}>
				<Body role="alert" tone="needs">
					Pilot could not save these words. They stay here; copy them before you close Pilot.
				</Body>
			</If>
			<If when={deliveryLine(a())}>
				<Body role="alert" tone="muted">
					{deliveryLine(a())}
				</Body>
			</If>
			<If when={messages()[id]}>
				<Body role="alert" tone="needs">
					{messages()[id] ?? ""}
				</Body>
			</If>
		</Question>
	);
}
