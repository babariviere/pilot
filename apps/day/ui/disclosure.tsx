// Content shown on request. Opening only shows what is already read: it
// sends, saves and changes nothing. The page owns whether each is open.
import { type JSX, Text, type ViewRef } from "nsh";
import { Collapsible } from "nsh/base";
import { Pressable } from "./button";

/** A quiet "▸ label" line; pressing it shows its content (`children`) below. */
export function Disclosure(props: {
	label: string;
	open: boolean;
	testID?: string;
	accessibilityLabel?: string;
	/** Hears the trigger's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	/** The trigger took or lost the keyboard focus. */
	onFocus?: () => void;
	onBlur?: () => void;
	onToggle: () => void;
	children?: JSX.Element;
}) {
	return (
		<Collapsible open={props.open} class="gap-1" content={props.children}>
			<Pressable
				testID={props.testID}
				accessibilityLabel={props.accessibilityLabel}
				anchor={props.anchor}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				expanded={props.open}
				onPress={props.onToggle}
				class="flex-row items-baseline gap-2 self-start rounded-md"
			>
				<Text class="text-sm text-muted-foreground">{props.open ? "▾" : "▸"}</Text>
				<Text class="text-sm text-muted-foreground">{props.label}</Text>
			</Pressable>
		</Collapsible>
	);
}

/**
 * One row of a divided list whose `content` shows below while `open`. Its `children` hold the row and its own
 * press target; use `ExpandableRow` when the whole row is the target.
 */
export function DividedRow(props: {
	open: boolean;
	/** Layout classes of the row, such as its padding. */
	class?: string;
	content: JSX.Element;
	children?: JSX.Element;
}) {
	return (
		<Collapsible open={props.open} class={`border-t border-border ${props.class ?? ""}`} content={props.content}>
			{props.children}
		</Collapsible>
	);
}

/**
 * One row of a divided list that opens in place: its summary (`children`) is the press target, and its `content`
 * shows below while `open`. The summary's `group-hover:` classes follow the pointer.
 */
export function ExpandableRow(props: {
	open: boolean;
	testID?: string;
	accessibilityLabel?: string;
	/** Hears the summary's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	/** The summary took or lost the keyboard focus. */
	onFocus?: () => void;
	onBlur?: () => void;
	onToggle: () => void;
	/** Layout classes of the row, such as its padding. */
	class?: string;
	/** Layout classes of the summary. */
	summaryClass?: string;
	content: JSX.Element;
	children?: JSX.Element;
}) {
	return (
		<DividedRow open={props.open} class={props.class} content={props.content}>
			<Pressable
				anchor={props.anchor}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				testID={props.testID}
				accessibilityLabel={props.accessibilityLabel}
				expanded={props.open}
				onPress={props.onToggle}
				class={`group rounded-md ${props.summaryClass ?? ""}`}
			>
				{props.children}
			</Pressable>
		</DividedRow>
	);
}
