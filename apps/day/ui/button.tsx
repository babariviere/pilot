// Commands. `Button` is the app's one button, in four kinds; `Link` is a command inside words or a section's
// head; `Chip` turns a help on and off. The older shapes below them are kept, restyled, while screens move to
// these three; each says what replaces it.
import { type JSX, Text, View, type ViewProps, type ViewRef } from "nsh";
import { Button as BaseButton, Toggle } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { Icon, type IconName } from "./icon";
import { Pill } from "./state";
import { TYPE } from "./text";

/** The keyboard's focus ring, shared by every control. */
export const FOCUS_RING = "focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * A button's kind. `primary` is the screen's one commit (Decide, Send, Save). `secondary` is every other command.
 * `quiet` lives only in the top bar and in a composer's bar. `destructive` removes or stops something for good and
 * stands apart, with one line that says what stays.
 */
export type ButtonKind = "primary" | "secondary" | "quiet" | "destructive";

const FRAME: Record<ButtonKind, string> = {
	primary: "bg-primary hover:opacity-95 active:opacity-90",
	secondary: "border border-border-strong bg-card hover:bg-accent active:bg-accent",
	quiet: "hover:bg-accent active:bg-accent",
	destructive: "border border-failed/45 hover:bg-failed-soft active:bg-failed-soft",
};
const WORDS: Record<ButtonKind, string> = {
	primary: "text-primary-foreground",
	secondary: "text-foreground",
	quiet: "text-muted-foreground group-hover:text-foreground",
	destructive: "text-failed-ink",
};
const TINT: Record<ButtonKind, string> = {
	primary: "tint-primary-foreground",
	secondary: "tint-foreground",
	quiet: "tint-muted-foreground",
	destructive: "tint-failed-ink",
};

/** What every button takes. */
export type ButtonProps = {
	label: string;
	/** The kind (default `secondary`). */
	kind?: ButtonKind;
	/** 20 points high instead of 26, for a row's trailing slot. */
	small?: boolean;
	icon?: IconName;
	/** Shows only the icon; the label still names it for screen readers and the tooltip. */
	iconOnly?: boolean;
	/** A count after the words, in a pill, such as how many reviews wait. */
	count?: number | string;
	disabled?: boolean;
	accessibilityLabel?: string;
	/** The keyboard shortcut, shown as a tooltip, such as "⌘↩". */
	shortcut?: string;
	testID?: string;
	/** Hears the button's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	/** What the screen agent must know: `confirm` for a commit only the person may press. */
	agent?: AgentMark;
	onPress: () => void;
};

/**
 * The app's button: its words, an optional icon before them and an optional count after them. 26 points high
 * (20 with `small`), radius 8. Rule: one `primary` per screen; `quiet` only in the top bar and a composer.
 */
export function Button(props: ButtonProps) {
	const kind = (): ButtonKind => props.kind ?? "secondary";
	const agent = useAgent({
		component: "button",
		label: () => props.accessibilityLabel ?? props.label,
		id: () => props.testID,
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: { press: () => props.onPress() },
	});
	const size = () => {
		if (props.iconOnly && props.count === undefined) return props.small ? "size-5" : "size-6.5";
		if (props.iconOnly) return props.small ? "h-5 px-1" : "h-6.5 px-1.5";
		return props.small ? "h-5 px-2" : "h-6.5 px-2.5";
	};
	return (
		<BaseButton
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? (props.iconOnly ? props.label : null)}
			tooltip={props.shortcut ? `${props.label}  ${props.shortcut}` : props.iconOnly ? props.label : undefined}
			onPress={props.onPress}
			class={`group min-w-0 shrink-0 flex-row items-center justify-center gap-1.5 rounded-lg transition duration-150 disabled:opacity-45 ${FOCUS_RING} ${size()} ${FRAME[kind()]}`}
		>
			<If when={props.icon}>
				<Icon name={props.icon as IconName} tint={TINT[kind()]} />
			</If>
			<If when={!props.iconOnly}>
				<Text class={`shrink truncate ${WORDS[kind()]}`} style={TYPE.control}>
					{props.label}
				</Text>
			</If>
			<If when={props.count !== undefined}>
				<Pill count={props.count ?? 0} />
			</If>
		</BaseButton>
	);
}

/**
 * A command inside words or in a section's head ("Show all 5", "Sign in", "Try now"): accent words, no frame.
 * `size` follows where it sits: `caption` in a section's head, a notice or a foot; `body` in a sentence. Rule:
 * a link is never the screen's commit; a link that only shows where work is is not the action that resolves it.
 */
export function Link(props: {
	label: string;
	/** The words' size (default `caption`). */
	size?: "caption" | "body";
	/** `faint` for a quiet disclosure such as "Show fewer". */
	tone?: "accent" | "faint";
	icon?: IconName;
	disabled?: boolean;
	accessibilityLabel?: string;
	testID?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onPress: () => void;
}) {
	const agent = useAgent({
		component: "button",
		label: () => props.accessibilityLabel ?? props.label,
		id: () => props.testID,
		disabled: () => props.disabled,
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
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? null}
			onPress={props.onPress}
			class={`group shrink-0 flex-row items-center gap-1 self-start rounded-sm disabled:opacity-45 ${FOCUS_RING}`}
		>
			<If when={props.icon}>
				<Icon name={props.icon as IconName} tint={props.tone === "faint" ? "tint-faint" : "tint-primary"} />
			</If>
			<Text
				class={`group-hover:underline ${props.tone === "faint" ? "text-faint" : "text-primary"}`}
				style={props.size === "body" ? TYPE.bodyStrong : TYPE.captionStrong}
			>
				{props.label}
			</Text>
		</BaseButton>
	);
}

/**
 * A chip that turns a help on and off ("Say it simpler", "More context"), 26 points high on a soft fill; pressed it
 * turns dark. Rule: chips only show or hide help; they never pick, send or approve.
 */
export function Chip(props: {
	label: string;
	pressed: boolean;
	testID?: string;
	/** The key that toggles it, shown as a tooltip. */
	shortcut?: string;
	disabled?: boolean;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: (pressed: boolean) => void;
}) {
	const agent = useAgent({
		component: "toggle",
		label: () => props.label,
		id: () => props.testID,
		state: { pressed: () => props.pressed },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: {
			setPressed: (on) => {
				if (on !== props.pressed) props.onChange(on === true);
			},
			toggle: () => props.onChange(!props.pressed),
		},
	});
	return (
		<Toggle
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			pressed={props.pressed}
			disabled={props.disabled}
			tooltip={props.shortcut ? `${props.label}  ${props.shortcut}` : undefined}
			onChange={({ pressed }) => props.onChange(pressed)}
			class={`group h-6.5 justify-center rounded-lg bg-soft px-2.5 hover:bg-accent aria-pressed:bg-foreground disabled:opacity-45 ${FOCUS_RING}`}
		>
			<Text class="text-muted-foreground group-aria-pressed:text-background" style={TYPE.caption}>
				{props.label}
			</Text>
		</Toggle>
	);
}

/** A wrapping row of `Chip`s (or of `EvidenceChip`s), 6 points apart. */
export function Chips(props: { testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="flex-row flex-wrap items-center gap-1.5">
			{props.children}
		</View>
	);
}

/** A wrapping row of buttons, 8 points apart: a form's or a row detail's commands. */
export function Buttons(props: { testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="flex-row flex-wrap items-center gap-2">
			{props.children}
		</View>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Older shapes, kept while screens move. Each draws in the new look; new code uses Button, Link or Chip.

/** @deprecated Use `ButtonKind`: `primary` stays, `outline` is `secondary`, `plain` is `quiet` (or a Link in page flow). */
export type ActionVariant = "plain" | "primary" | "outline";

const ACTION_KIND: Record<ActionVariant, ButtonKind> = { primary: "primary", outline: "secondary", plain: "quiet" };

/**
 * @deprecated Use `Button` (a command) or `Link` (a command in page flow, such as "Show all"). `variant` maps to
 * Button's `kind`: primary → primary, outline → secondary, plain → quiet.
 */
export function Action(props: {
	label: string;
	variant?: ActionVariant;
	icon?: IconName;
	iconOnly?: boolean;
	badge?: string;
	disabled?: boolean;
	accessibilityLabel?: string;
	shortcut?: string;
	testID?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onPress: () => void;
}) {
	return (
		<Button
			label={props.label}
			kind={ACTION_KIND[props.variant ?? "plain"]}
			icon={props.icon}
			iconOnly={props.iconOnly}
			count={props.badge}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel}
			shortcut={props.shortcut}
			testID={props.testID}
			anchor={props.anchor}
			agent={props.agent}
			onPress={props.onPress}
		/>
	);
}

/** @deprecated Use `Pill`. */
export function Badge(props: { label: string }) {
	return <Pill count={props.label} />;
}

/** @deprecated Use `Link` with `size="body"`. */
export function InlineAction(props: { label: string; testID?: string; agent?: AgentMark; onPress: () => void }) {
	return <Link label={props.label} size="body" testID={props.testID} agent={props.agent} onPress={props.onPress} />;
}

/** @deprecated Use `Row` with `onPress`: the row is the press target and its slots hold the rest. */
export function RowLink(props: {
	testID: string;
	title: string;
	accessibilityLabel: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onPress: () => void;
	children?: JSX.Element;
}) {
	const agent = useAgent({
		component: "button",
		label: () => props.accessibilityLabel ?? props.title,
		id: () => props.testID,
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
			accessibilityLabel={props.accessibilityLabel}
			onPress={props.onPress}
			class={`group flex-row items-center gap-3 rounded-md ${FOCUS_RING}`}
		>
			<Text class="flex-1 text-foreground group-hover:underline" style={TYPE.bodyStrong}>
				{props.title}
			</Text>
			{props.children}
		</BaseButton>
	);
}

/** @deprecated Use `Chip` (the same part under its new name). */
export function ToggleChip(props: {
	label: string;
	pressed: boolean;
	testID?: string;
	shortcut?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: (pressed: boolean) => void;
}) {
	return (
		<Chip
			label={props.label}
			pressed={props.pressed}
			testID={props.testID}
			shortcut={props.shortcut}
			anchor={props.anchor}
			agent={props.agent}
			onChange={props.onChange}
		/>
	);
}

/**
 * @deprecated Use `Link` (a command) or `Chip` (on and off). `pressed` still makes it a toggle that shows when it
 * is on.
 */
export function LinkAction(props: {
	label: string;
	testID?: string;
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	pressed?: boolean;
	tone?: "primary" | "faint";
	agent?: AgentMark;
	onPress: () => void;
}) {
	const agent = useAgent({
		component: "button",
		label: () => props.accessibilityLabel ?? props.label,
		id: () => props.testID,
		state: { pressed: () => props.pressed },
		mark: () => props.agent,
		actions: { press: () => props.onPress() },
	});
	const anchor = (node: ViewRef) => {
		agent.anchor(node);
		props.anchor?.(node);
	};
	const words = () => (props.tone === "faint" ? "text-faint" : "text-primary");
	return (
		<If
			when={props.pressed !== undefined}
			else={
				<BaseButton
					ref={anchor}
					testID={props.testID}
					accessibilityLabel={props.accessibilityLabel ?? null}
					onPress={props.onPress}
					class={`group rounded-md px-1 ${FOCUS_RING}`}
				>
					<Text class={`group-hover:underline ${words()}`} style={TYPE.captionStrong}>
						{props.label}
					</Text>
				</BaseButton>
			}
		>
			<Toggle
				ref={anchor}
				testID={props.testID}
				accessibilityLabel={props.accessibilityLabel ?? null}
				pressed={props.pressed === true}
				onChange={props.onPress}
				class={`rounded-md px-1.5 hover:bg-accent aria-pressed:bg-selection ${FOCUS_RING}`}
			>
				<Text class={words()} style={TYPE.captionStrong}>
					{props.label}
				</Text>
			</Toggle>
		</If>
	);
}

/**
 * A bare press target: the app's focus ring and nothing else. For library parts and the single-use overlays (the
 * palette, the full-window artifact). A screen uses `Row`, `Button` or `Link` instead. With `expanded` it is a
 * disclosure's trigger, and screen readers say whether its content shows.
 */
export function Pressable(props: {
	testID?: string;
	accessibilityLabel?: string;
	tooltip?: string;
	disabled?: boolean;
	/** The current item of a set, such as the chosen place on a chart: screen readers say so. */
	selected?: boolean;
	/** Whether the content it shows is expanded. */
	expanded?: boolean;
	/** Hears the target's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	/** The screen agent's name for a target whose words are its content, such as a disclosure's label. */
	agentLabel?: string;
	agent?: AgentMark;
	/** It took or lost the keyboard focus. Only a disclosure's trigger (`expanded` set) reports it. */
	onFocus?: () => void;
	onBlur?: () => void;
	/** Layout and frame classes; the focus ring is added. */
	class?: string;
	classList?: Record<string, boolean>;
	/** Inline style, for a position or a transform the page computes. */
	style?: ViewProps["style"];
	onPress: () => void;
	children?: JSX.Element;
}) {
	const look = () => `${props.class ?? ""} ${FOCUS_RING}`;
	// A disclosure's trigger is a disclosure to the agent: it reads and sets whether its content shows.
	const agent = useAgent({
		component: props.expanded !== undefined ? "disclosure" : "button",
		label: () => props.accessibilityLabel ?? props.agentLabel ?? props.tooltip,
		id: () => props.testID,
		state: { selected: () => props.selected, open: () => props.expanded },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions:
			props.expanded !== undefined
				? {
						setOpen: (open) => {
							if (open !== props.expanded) props.onPress();
						},
						toggle: () => props.onPress(),
					}
				: { press: () => props.onPress() },
	});
	const anchor = (node: ViewRef) => {
		agent.anchor(node);
		props.anchor?.(node);
	};
	return (
		<If
			when={props.expanded !== undefined}
			else={
				<BaseButton
					ref={anchor}
					testID={props.testID}
					accessibilityLabel={props.accessibilityLabel ?? null}
					tooltip={props.tooltip}
					disabled={props.disabled}
					selected={props.selected}
					onPress={props.onPress}
					class={look()}
					classList={props.classList}
					style={props.style}
				>
					{props.children}
				</BaseButton>
			}
		>
			<View
				ref={anchor}
				testID={props.testID}
				role="button"
				accessibilityLabel={props.accessibilityLabel}
				accessibilityState={{ expanded: props.expanded === true, disabled: props.disabled === true }}
				tooltip={props.tooltip}
				onPress={props.disabled ? undefined : props.onPress}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				class={look()}
				classList={props.classList}
				style={props.style}
			>
				{props.children}
			</View>
		</If>
	);
}
