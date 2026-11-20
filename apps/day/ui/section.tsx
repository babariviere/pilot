// Sections and rows: the content of a panel. A section is a heading, a count pill, a note, at most one action,
// its body and a foot. A row is the one list item of the app, with five slots: mark, title, meta, state and
// trailing. Settings, missions, requests and working chats all use the same row.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Button as BaseButton, Collapsible } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING, Link, Pressable } from "./button";
import { Mark, type MarkKind, Pill, STATE_FILL } from "./state";
import { Heading, TONE, type Tone, TYPE } from "./text";

/**
 * A section of a panel: its head (heading, count pill, a quiet note, at most one action at the right), its body
 * (`Rows`, a `Question`, a `Block` of text, an `EmptyLine`) and an optional foot: a `more` link ("Show all 9") and a
 * quiet `footnote`. Sections in a column are split by hairlines. Rule: at most five rows, then a Show all link; one
 * action in the head.
 */
export function Section(props: {
	title: string;
	/** The count beside the heading. Hidden when 0 or absent. */
	count?: number | null;
	/** A quiet note after the count, such as "From Slack and Linear" or "21 min ago". */
	note?: string;
	/** At most one action at the right of the head: a `Link`. */
	action?: JSX.Element;
	/** The foot's link, such as "Show all 9" or "Show fewer". */
	more?: { label: string; onPress: () => void; testID?: string };
	/** A quiet line in the foot, such as "3 earlier results are not shown here." */
	footnote?: string;
	footnoteTestID?: string;
	testID?: string;
	children?: JSX.Element;
}) {
	return (
		<View testID={props.testID} class="border-t border-border pb-1">
			<View class="min-h-11 flex-row items-center gap-2 px-4 pb-1 pt-3.5">
				<Heading role="header">{props.title}</Heading>
				<If when={props.count}>
					<Pill count={props.count ?? 0} />
				</If>
				<If when={props.note}>
					<Text class="min-w-0 shrink truncate pl-0.5 font-mono text-faint" style={TYPE.number}>
						{props.note ?? ""}
					</Text>
				</If>
				<View class="flex-1" />
				{props.action}
			</View>
			{props.children}
			<If when={props.more || props.footnote}>
				<View class="flex-row flex-wrap items-center gap-3 px-4 pb-2.5 pt-1.5">
					<If when={props.more}>
						{(more) => <Link label={more().label} testID={more().testID} onPress={() => more().onPress()} />}
					</If>
					<If when={props.footnote}>
						<Text testID={props.footnoteTestID} class="text-faint" style={TYPE.caption}>
							{props.footnote ?? ""}
						</Text>
					</If>
				</View>
			</If>
		</View>
	);
}

/**
 * Padded content inside a section that is not rows: sentences, a report, a form, a chat. It lines up with the
 * section's heading (16 points at the sides). `gap` spaces its children (Tailwind's scale, default 2).
 */
export function Block(props: { testID?: string; gap?: 1 | 2 | 3 | 4; selectable?: boolean; children?: JSX.Element }) {
	const gap = { 1: "gap-1", 2: "gap-2", 3: "gap-3", 4: "gap-4" }[props.gap ?? 2];
	return (
		<View testID={props.testID} selectable={props.selectable} class={`px-4 pb-2.5 pt-1.5 ${gap}`}>
			{props.children}
		</View>
	);
}

/** The one quiet line of an empty section ("No new requests from Slack or Linear."). It never looks like an error. */
export function EmptyLine(props: { text: string; testID?: string }) {
	return (
		<Text testID={props.testID} class="px-4 pb-2.5 pt-1.5 text-faint" style={TYPE.caption}>
			{props.text}
		</Text>
	);
}

/**
 * A quiet label that splits one section's rows into groups ("Moving · 2", "Waiting · 1"). Use it only when the
 * groups mean something different; otherwise keep one list.
 */
export function RowGroup(props: { label: string; testID?: string }) {
	return (
		<Text testID={props.testID} class="px-4 pb-0.5 pt-2 text-faint" style={TYPE.caption}>
			{props.label}
		</Text>
	);
}

/**
 * A list of `Row`s, split by hairlines that start at the row's content (16 points in). The first row draws no
 * hairline. `flush` is for rows inside a `Question` or a `Block`: they reach out to the section's edges, so they
 * line up with the section's other rows instead of indenting twice.
 */
export function Rows(props: { testID?: string; flush?: boolean; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class={`overflow-hidden ${props.flush ? "-mx-4" : ""}`}>
			<View class="-mt-px">{props.children}</View>
		</View>
	);
}

/** A state word's tone in a row's state slot. */
export type RowTone = "needs" | "failed" | "ok" | "quiet";

const ROW_TONE: Record<RowTone, Tone> = { needs: "needs", failed: "failed", ok: "ok", quiet: "muted" };

/**
 * The one row of every list. Five slots, each filled or empty, never restyled: `mark` (a state `Mark`), `title` (one
 * line, cut off when long), `meta` (one caption line: project, reason, source), `state` (a word in a soft pill,
 * toned by `stateTone`) and `trailing` (a `Num` time, a `Progress`, a small `Button`, a `Switch` or a `Picker`).
 * With `onPress` the whole row is the press target and opens what it names; its trailing slot then holds no
 * button. `detail` holds what a row must show under its meta, wrapped in a `RowDetail`: its own Continue and
 * Dismiss, a quote. It stays outside the press target. Use it rarely.
 *
 * A row that opens in place takes `open` and `onToggle` instead of `onPress`: pressing it shows `content` under it
 * (screen readers hear it expanded or collapsed), and `onFocus`/`onBlur` report the keyboard focus. `aside` sits
 * at the right outside the press target (its chat link), and `detail` is a line that always shows. Rule: opening
 * only shows what is already read; it sends, saves and changes nothing.
 */
export function Row(props: {
	title: string;
	mark?: MarkKind;
	meta?: string;
	state?: string;
	stateTone?: RowTone;
	trailing?: JSX.Element;
	detail?: JSX.Element;
	/** Beside the row, outside its press target: a link or a small button of its own. */
	aside?: JSX.Element;
	/** The title may wrap instead of cutting off: for sentences, such as a result's words. */
	wrap?: boolean;
	/** Limit a wrapped title to two lines, for incoming requests. Meta stays on one line. */
	titleLines?: 2;
	/** The chosen row of a list. */
	selected?: boolean;
	testID?: string;
	/** The title's own test ID. */
	titleTestID?: string;
	/** The meta line's own test ID. */
	metaTestID?: string;
	/** What screen readers say for a pressable row: its title, state and what pressing does. */
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	selectable?: boolean;
	onPress?: () => void;
	/** Whether a row that opens in place shows its `content` (with `onToggle`). */
	open?: boolean;
	/** Opens or closes the row in place. The page owns `open`. */
	onToggle?: () => void;
	/** What shows under a row that opens in place while it is open. */
	content?: JSX.Element;
	/** The press target took or lost the keyboard focus (a row that opens in place). */
	onFocus?: () => void;
	onBlur?: () => void;
}) {
	const content = () => (
		<>
			<If when={props.mark}>
				<View class="h-4.5 w-3.5 items-center justify-center">
					<Mark kind={props.mark as MarkKind} />
				</View>
			</If>
			<View class="min-w-0 flex-1" selectable={props.selectable}>
				<Text
					testID={props.titleTestID}
					class={`text-foreground ${props.wrap || props.titleLines ? "" : "truncate"}`}
					style={{ ...TYPE.bodyStrong, numberOfLines: props.titleLines }}
				>
					{props.title}
				</Text>
				<If when={props.meta}>
					<Text
						testID={props.metaTestID}
						class={`pt-px text-faint ${props.wrap ? "" : "truncate"}`}
						style={TYPE.caption}
					>
						{props.meta ?? ""}
					</Text>
				</If>
			</View>
			<If when={props.state}>
				<View
					class={`h-5.5 shrink-0 justify-center self-center rounded-full px-2.5 ${STATE_FILL[ROW_TONE[props.stateTone ?? "quiet"]]}`}
				>
					<Text class={TONE[ROW_TONE[props.stateTone ?? "quiet"]]} style={TYPE.caption}>
						{props.state ?? ""}
					</Text>
				</View>
			</If>
			<View class="shrink-0 flex-row items-center gap-2 self-center">{props.trailing}</View>
		</>
	);
	const look = () =>
		`flex-row items-start gap-2.5 py-1.5 pl-4 ${props.aside ? "min-w-0 flex-1 pr-2" : "pr-4"} ${props.selected ? "bg-selection" : ""}`;
	const line = () => (
		<If
			when={props.onToggle}
			else={
				<If when={props.onPress} else={<View class={look()}>{content()}</View>}>
					<PressRow
						testID={props.testID}
						label={props.accessibilityLabel ?? props.title}
						anchor={props.anchor}
						agent={props.agent}
						selected={props.selected}
						class={look()}
						onPress={() => props.onPress?.()}
					>
						{content()}
					</PressRow>
				</If>
			}
		>
			<Pressable
				testID={props.testID}
				accessibilityLabel={props.accessibilityLabel ?? props.title}
				anchor={props.anchor}
				agent={props.agent}
				expanded={props.open === true}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				onPress={() => props.onToggle?.()}
				class={`${look()} hover:bg-accent active:bg-accent`}
			>
				{content()}
			</Pressable>
		</If>
	);
	const pressable = () => !!props.onPress || !!props.onToggle;
	const inset = () => (props.mark ? "pl-10 pr-4" : "px-4");
	const body = () => (
		<>
			<If when={props.aside} else={line()}>
				<View class="flex-row items-start">
					{line()}
					<View class="shrink-0 flex-row items-center gap-2 self-center pr-4">{props.aside}</View>
				</View>
			</If>
			<View class={inset()}>{props.detail}</View>
		</>
	);
	return (
		<View testID={pressable() ? undefined : props.testID} class="relative">
			<If when={props.onToggle} else={body()}>
				<Collapsible
					open={props.open === true}
					content={<View class={`gap-1.5 pb-2.5 pt-1 ${inset()}`}>{props.content}</View>}
				>
					{body()}
				</Collapsible>
			</If>
			<View class="absolute left-4 right-0 top-0 h-px bg-border" />
		</View>
	);
}

/** What a row shows under its meta (`Row`'s `detail`): its own buttons, a quote. Spaced under the row. */
export function RowDetail(props: { testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="-mt-0.5 gap-1.5 pb-2">
			{props.children}
		</View>
	);
}

/** A row's press target: the whole row, with a hover fill and the focus ring. */
function PressRow(props: {
	testID?: string;
	label: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	selected?: boolean;
	class: string;
	onPress: () => void;
	children?: JSX.Element;
}) {
	const agent = useAgent({
		component: "button",
		label: () => props.label,
		id: () => props.testID,
		state: { selected: () => props.selected },
		mark: () => props.agent,
		actions: { press: () => props.onPress() },
	});
	return (
		<BaseButton
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			accessibilityLabel={props.label}
			selected={props.selected}
			onPress={props.onPress}
			class={`${props.class} hover:bg-accent active:bg-accent ${FOCUS_RING}`}
		>
			{props.children}
		</BaseButton>
	);
}
