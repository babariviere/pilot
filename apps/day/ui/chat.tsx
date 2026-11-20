// Chat pieces: a chat reads as a conversation, not a log. The user's bubble, the agent's reply, a folded turn's
// steps (fold them with `Disclosure`), one-line events, a scheduled bubble, the tray of tasks and subagents, the
// working line above the composer, and the composer. A quote or code block is a `Quote`.
import { type JSX, Text, View } from "nsh";
import { Pressable } from "./button";
import { Icon } from "./icon";
import { Mark } from "./state";
import { TYPE } from "./text";

/**
 * The user's message: a muted bubble at the right, hugging short words, at most 80% of the width. `scheduled` draws
 * it as a dashed outline with muted words, for a message that waits to send ("Tomorrow 9:00 · …").
 */
export function Bubble(props: { text?: string; scheduled?: boolean; testID?: string; children?: JSX.Element }) {
	return (
		<View
			testID={props.testID}
			selectable
			class={`max-w-[80%] self-end rounded-[14px] px-3 py-1.5 ${props.scheduled ? "border border-dashed border-input" : "bg-muted"}`}
		>
			<If when={props.text !== undefined} else={props.children}>
				<Text class={props.scheduled ? "text-muted-foreground" : "text-foreground"} style={TYPE.body}>
					{props.text ?? ""}
				</Text>
			</If>
		</View>
	);
}

/** The agent's answer: sentences at a reading width, selectable. Put Markdown, a `Quote` or code inside. */
export function Reply(props: { testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} selectable class="max-w-xl gap-2">
			{props.children}
		</View>
	);
}

/** One step of a turn. `running` marks the step that runs now. */
export type ChatStep = { id: string; text: string; running?: boolean };

/** A turn's steps, under its `Disclosure` line: one caption sentence each, on a hairline, the running one darker. */
export function Steps(props: { steps: ChatStep[]; testID?: string }) {
	return (
		<View testID={props.testID} class="ml-1.5 gap-1 border-l border-input pl-3">
			<Each of={props.steps} key={(s) => s.id}>
				{(s) => (
					<Text class={s().running ? "text-foreground" : "text-muted-foreground"} style={TYPE.caption}>
						{s().text}
					</Text>
				)}
			</Each>
		</View>
	);
}

/**
 * An automatic item, written for the user, on one quiet line: "Agent pushed native/zoom · e93b1a0 · 31 min ago".
 * Only a real failure gets a red mark (`failed`).
 */
export function Event(props: { text: string; failed?: boolean; testID?: string }) {
	return (
		<View testID={props.testID} class="flex-row items-center gap-1.5">
			<If when={props.failed}>
				<Mark kind="failed" />
			</If>
			<Text class={props.failed ? "text-failed-ink" : "text-faint"} style={TYPE.caption}>
				{props.text}
			</Text>
		</View>
	);
}

/** The composer's tray: one summary line of the chat's tasks and subagents ("Tasks 2 of 6 · 3 subagents, 1 working"). */
export function Tray(props: {
	summary: string;
	open?: boolean;
	testID?: string;
	onToggle?: () => void;
	children?: JSX.Element;
}) {
	return (
		<View class="rounded-lg border border-border">
			<Pressable
				testID={props.testID}
				expanded={props.onToggle ? props.open === true : undefined}
				agentLabel={props.summary}
				onPress={() => props.onToggle?.()}
				class="flex-row items-center gap-2 rounded-lg px-2.5 py-1.5"
			>
				<Icon name={props.open ? "chevron" : "right"} tint="tint-muted-foreground" />
				<Text class="text-muted-foreground" style={TYPE.caption}>
					{props.summary}
				</Text>
			</Pressable>
			<If when={props.open}>
				<View class="border-t border-border px-2.5 py-1.5">{props.children}</View>
			</If>
		</View>
	);
}

/**
 * Live work, directly above the composer: three still dots and its words ("Working… · 1 job"). `background` makes
 * it fainter, for an agent that waits on background jobs.
 */
export function WorkingLine(props: { text: string; background?: boolean; testID?: string }) {
	return (
		<View testID={props.testID} class={`flex-row items-center gap-2 ${props.background ? "opacity-60" : ""}`}>
			<View class="flex-row items-center gap-0.75">
				<View class="size-1 rounded-full bg-faint" />
				<View class="size-1 -translate-y-0.5 rounded-full bg-progress" />
				<View class="size-1 rounded-full bg-faint" />
			</View>
			<Text class="text-muted-foreground" style={TYPE.caption}>
				{props.text}
			</Text>
		</View>
	);
}

/**
 * Where a message is written: a soft frame holding the `field` (a `TextField variant="composer"`) and a `bar` under
 * it (a quiet model `Picker` or `Button`, a spacer, `KeyHints` and the Send button).
 */
export function Composer(props: { field: JSX.Element; bar?: JSX.Element; testID?: string }) {
	return (
		<View testID={props.testID} class="gap-2 rounded-(--radius-panel) bg-soft py-2.5 pl-3.5 pr-2.5">
			{props.field}
			<View class="flex-row items-center gap-2">{props.bar}</View>
		</View>
	);
}

/** Quoted words or code on a muted block with a hairline: a planner's last message, a command, a diff line. */
export function Quote(props: { text?: string; code?: boolean; testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} selectable class="gap-1 rounded-lg border border-border bg-muted px-3 py-2.5">
			<If when={props.text !== undefined} else={props.children}>
				<Text
					class={`text-foreground ${props.code ? "font-mono" : ""}`}
					style={props.code ? { fontSize: 12, lineHeight: 18.5 } : TYPE.body}
				>
					{props.text ?? ""}
				</Text>
			</If>
		</View>
	);
}
