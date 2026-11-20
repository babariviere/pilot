// Content shown on request. Opening only shows what is already read: it
// sends, saves and changes nothing. The page owns whether each is open.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Collapsible } from "nsh/base";
import { Pressable } from "./button";
import { Icon } from "./icon";
import { TYPE } from "./text";

/**
 * A quiet "› label" line; pressing it shows its content (`children`) below. A chat's folded turn uses `Fold`, which
 * draws the same line.
 */
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
				agentLabel={props.label}
				anchor={props.anchor}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				expanded={props.open}
				onPress={props.onToggle}
				class="flex-row items-center gap-1 self-start rounded-md"
			>
				<Icon name={props.open ? "chevron" : "right"} tint="tint-muted-foreground" />
				<Text class="text-muted-foreground" style={TYPE.caption}>
					{props.label}
				</Text>
			</Pressable>
		</Collapsible>
	);
}

/**
 * One row of a divided list whose `content` shows below while `open`. Its `children` hold the row and its own
 * press target; use `ExpandableRow` when the whole row is the target. Its hairline starts 16 points in, as a
 * `Row`'s does.
 */
export function DividedRow(props: { open: boolean; content: JSX.Element; children?: JSX.Element }) {
	return (
		<View class="relative">
			<Collapsible open={props.open} content={props.content}>
				{props.children}
			</Collapsible>
			<View class="absolute left-4 right-0 top-0 h-px bg-border" />
		</View>
	);
}

/**
 * One row of a divided list that opens a part of the page in place ("Goal and spec", a screen's Before and After):
 * its summary (`children`: a chevron `Icon`, a `BodyStrong grow`, a `Caption`) is the press target, laid out in a
 * row with a Row's spacing, and its `content` shows below while `open`. A list item that opens in place is a `Row`
 * with `onToggle`; this is for a part of the page that has no state of its own.
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
	content: JSX.Element;
	children?: JSX.Element;
}) {
	return (
		<DividedRow open={props.open} content={props.content}>
			<Pressable
				anchor={props.anchor}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				testID={props.testID}
				accessibilityLabel={props.accessibilityLabel}
				expanded={props.open}
				onPress={props.onToggle}
				class="group flex-row items-center gap-2.5 px-4 py-1.5 hover:bg-accent active:bg-accent"
			>
				{props.children}
			</Pressable>
		</DividedRow>
	);
}
