// Commands. `Action` is the app's button; the others are its few special
// shapes: a link inside a sentence, a row that opens what it names, a chip
// that toggles help, and `Pressable`, a bare press target for custom rows.
import { type JSX, Text, View, type ViewProps, type ViewRef } from "nsh";
import { Button, Toggle } from "nsh/base";
import { Icon, type IconName } from "./icon";

/** The keyboard's focus ring, shared by every control. */
export const FOCUS_RING = "focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * How an `Action` looks. `primary` marks the screen's one default commit; `outline` gives a standing command,
 * such as New, a quiet frame; `plain` (the default) is every other command.
 */
export type ActionVariant = "plain" | "primary" | "outline";

const ACTION_FRAME: Record<ActionVariant, string> = {
	primary: "bg-primary px-3.5 active:opacity-90",
	outline: "border border-border-strong bg-background px-3 hover:bg-accent active:bg-accent",
	plain: "px-3 hover:bg-accent active:bg-accent",
};
const ACTION_WORDS: Record<ActionVariant, string> = {
	primary: "text-sm font-medium text-primary-foreground",
	outline: "text-sm font-medium text-foreground",
	plain: "text-sm text-muted-foreground",
};
const ACTION_TINT: Record<ActionVariant, string> = {
	primary: "tint-primary-foreground",
	outline: "tint-foreground",
	plain: "tint-muted-foreground",
};

/** A command: its words, an optional icon before them, and an optional count after them. */
export function Action(props: {
	label: string;
	/** The look (default `plain`). */
	variant?: ActionVariant;
	icon?: IconName;
	/** Shows only the icon; the label still names it for screen readers and the tooltip. */
	iconOnly?: boolean;
	/** A short count after the words, such as how many reviews wait. */
	badge?: string;
	disabled?: boolean;
	accessibilityLabel?: string;
	/** The keyboard shortcut, shown as a tooltip, such as "⌘↩". */
	shortcut?: string;
	testID?: string;
	/** Hears the button's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
}) {
	const variant = (): ActionVariant => props.variant ?? "plain";
	const frame = () =>
		props.iconOnly && variant() === "plain"
			? "min-w-8 justify-center px-2 hover:bg-accent active:bg-accent"
			: ACTION_FRAME[variant()];
	return (
		<Button
			ref={props.anchor}
			testID={props.testID}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? (props.iconOnly ? props.label : null)}
			tooltip={props.shortcut ? `${props.label}  ${props.shortcut}` : props.iconOnly ? props.label : undefined}
			onPress={props.onPress}
			class={`min-h-8 min-w-0 flex-row items-center gap-1.5 rounded-lg py-1 transition duration-150 disabled:opacity-50 ${FOCUS_RING} ${frame()}`}
		>
			<If when={props.icon}>
				<Icon name={props.icon as IconName} tint={ACTION_TINT[variant()]} />
			</If>
			<If when={!props.iconOnly}>
				<Text class={`shrink truncate ${ACTION_WORDS[variant()]}`}>{props.label}</Text>
			</If>
			<If when={props.badge}>
				<Badge label={props.badge ?? ""} />
			</If>
		</Button>
	);
}

/** A small round count, such as the reviews that wait. */
export function Badge(props: { label: string }) {
	return (
		<View class="h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5">
			<Text class="text-xs font-semibold text-foreground">{props.label}</Text>
		</View>
	);
}

/** An inline text command inside a sentence. */
export function InlineAction(props: { label: string; testID?: string; onPress: () => void }) {
	return (
		<Button testID={props.testID} onPress={props.onPress} class={`rounded-sm ${FOCUS_RING}`}>
			<Text class="text-sm text-needs-ink underline">{props.label}</Text>
		</Button>
	);
}

/** A row that opens what it names: its title, then trailing content. */
export function RowLink(props: {
	testID: string;
	title: string;
	accessibilityLabel: string;
	/** Hears the row's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
	children?: JSX.Element;
}) {
	return (
		<Button
			ref={props.anchor}
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			onPress={props.onPress}
			class={`group flex-row items-baseline gap-3 rounded-md ${FOCUS_RING}`}
		>
			<Text class="flex-1 text-sm font-medium text-foreground group-hover:underline">{props.title}</Text>
			{props.children}
		</Button>
	);
}

/** A rounded chip that turns something on and off, such as a help panel on a decision card. */
export function ToggleChip(props: {
	label: string;
	pressed: boolean;
	testID?: string;
	/** The key that toggles it, shown as a tooltip. */
	shortcut?: string;
	/** Hears the chip's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	onChange: (pressed: boolean) => void;
}) {
	return (
		<Toggle
			ref={props.anchor}
			testID={props.testID}
			pressed={props.pressed}
			tooltip={props.shortcut ? `${props.label}  ${props.shortcut}` : undefined}
			onChange={({ pressed }) => props.onChange(pressed)}
			class={`group rounded-full border border-border-strong px-3 py-1 hover:bg-accent aria-pressed:border-primary/40 aria-pressed:bg-selection ${FOCUS_RING}`}
		>
			<Text class="text-xs text-muted-foreground group-aria-pressed:text-foreground">{props.label}</Text>
		</Toggle>
	);
}

/** A small text command in a toolbar line, such as "All answers". `pressed` makes it a toggle. */
export function LinkAction(props: {
	label: string;
	testID?: string;
	accessibilityLabel?: string;
	/** Set to make it a toggle that shows when it is on. */
	pressed?: boolean;
	/** The look of the words (default `primary`): `faint` for a quiet disclosure. */
	tone?: "primary" | "faint";
	onPress: () => void;
}) {
	const words = () => (props.tone === "faint" ? "text-xs text-faint" : "text-xs text-primary");
	return (
		<If
			when={props.pressed !== undefined}
			else={
				<Button
					testID={props.testID}
					accessibilityLabel={props.accessibilityLabel ?? null}
					onPress={props.onPress}
					class={`rounded-md px-1.5 hover:bg-accent ${FOCUS_RING}`}
				>
					<Text class={words()}>{props.label}</Text>
				</Button>
			}
		>
			<Toggle
				testID={props.testID}
				accessibilityLabel={props.accessibilityLabel ?? null}
				pressed={props.pressed === true}
				onChange={props.onPress}
				class={`rounded-md px-1.5 hover:bg-accent aria-pressed:bg-selection ${FOCUS_RING}`}
			>
				<Text class={words()}>{props.label}</Text>
			</Toggle>
		</If>
	);
}

/**
 * A bare press target for a custom row or card: the app's focus ring and nothing else. Its `class` lays out and
 * frames its content; use `Action` for an ordinary command. With `expanded` it is a disclosure's trigger, and
 * screen readers say whether its content shows.
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
	return (
		<If
			when={props.expanded !== undefined}
			else={
				<Button
					ref={props.anchor}
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
				</Button>
			}
		>
			<View
				ref={(node: ViewRef) => props.anchor?.(node)}
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
