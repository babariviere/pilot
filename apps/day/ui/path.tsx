// The top bar: where you are, as a path at the top left ("Pilot / Today ▾"), then the window's few commands at the
// right: Search with Command+K and New. The last part of the path opens a menu of the places beside it.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { Icon } from "./icon";
import { KeyCap } from "./keys";
import { Menu } from "./picker";
import { TYPE } from "./text";

/**
 * The window's top bar, 52 points high with a hairline under it, on the canvas: the path (`children`: `Logo`,
 * `PathSegment`s, `PathSlash`es, a `PathMenu`) at the left, then `trailing` at the right (notices that need the user,
 * quiet icon `Button`s, `SearchButton`, New). Rule: it stays put while the pages below change.
 */
export function PathBar(props: { testID?: string; trailing?: JSX.Element; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="h-13 flex-row items-center gap-1 border-b border-border px-3.5">
			<View class="min-w-0 shrink flex-row items-center gap-0.5">{props.children}</View>
			<View class="flex-1" />
			<View class="flex-row items-center gap-1.5">{props.trailing}</View>
		</View>
	);
}

/** Pilot's mark: a small accent square. */
export function Logo() {
	return <View class="mx-1.5 size-4 rounded-md bg-primary" />;
}

/** The slash between two parts of the path. */
export function PathSlash() {
	return (
		<Text class="px-0.5 text-faint" style={TYPE.body}>
			/
		</Text>
	);
}

/**
 * A quiet note in the top bar: the project this window acts on, or `dashed` "Mock data" on a fixture's window. It
 * is not a command.
 */
export function PathNote(props: { text: string; dashed?: boolean; testID?: string }) {
	return (
		<View
			testID={props.testID}
			class={`max-w-40 shrink rounded-md px-1.5 py-0.5 ${props.dashed ? "border border-dashed border-input" : ""}`}
		>
			<Text class="truncate text-faint" style={TYPE.caption}>
				{props.text}
			</Text>
		</View>
	);
}

/** One part of the path that goes somewhere: "Pilot" goes to Today, a parent goes up one level (Back). */
export function PathSegment(props: {
	label: string;
	testID?: string;
	accessibilityLabel?: string;
	tooltip?: string;
	agent?: AgentMark;
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
}) {
	const agent = useAgent({
		component: "button",
		label: () => props.accessibilityLabel ?? props.label,
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
			accessibilityLabel={props.accessibilityLabel ?? null}
			tooltip={props.tooltip}
			onPress={props.onPress}
			class={`h-7 min-w-0 shrink justify-center rounded-lg px-2 hover:bg-soft active:bg-soft ${FOCUS_RING}`}
		>
			<Text class="truncate text-muted-foreground" style={TYPE.control}>
				{props.label}
			</Text>
		</BaseButton>
	);
}

/**
 * The path's last part, where you are, with a chevron: it opens a menu of the places beside it (`MenuItem`s). The
 * page owns whether the menu is open.
 */
export function PathMenu(props: {
	label: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	testID?: string;
	children?: JSX.Element;
}) {
	return (
		<Menu
			open={props.open}
			onOpenChange={props.onOpenChange}
			agentLabel={props.label}
			trigger={
				<View
					testID={props.testID}
					role="button"
					accessibilityLabel={`${props.label}. Go to another place`}
					class={`h-7 min-w-0 shrink flex-row items-center gap-1 rounded-lg pl-2 pr-1.5 hover:bg-soft ${FOCUS_RING}`}
				>
					<Text class="truncate text-foreground" style={{ ...TYPE.control, fontWeight: "600" }}>
						{props.label}
					</Text>
					<Icon name="chevron" tint="tint-faint" />
				</View>
			}
		>
			{props.children}
		</Menu>
	);
}

/**
 * Search, with its shortcut: a framed field-like button that opens the command palette. `compact` shows only the
 * magnifier, for a narrow window.
 */
export function SearchButton(props: {
	keys: string;
	compact?: boolean;
	testID?: string;
	agent?: AgentMark;
	onPress: () => void;
}) {
	const agent = useAgent({
		component: "button",
		label: () => "Search",
		id: () => props.testID,
		mark: () => props.agent,
		actions: { press: () => props.onPress() },
	});
	return (
		<BaseButton
			ref={agent.anchor}
			testID={props.testID}
			accessibilityLabel="Search"
			tooltip={`Search  ${props.keys}`}
			onPress={props.onPress}
			class={`h-6.5 flex-row items-center gap-1.5 rounded-(--radius-panel) border border-input bg-card hover:bg-accent ${props.compact ? "w-6.5 justify-center" : "pl-2 pr-1"} ${FOCUS_RING}`}
		>
			<Icon name="search" tint="tint-faint" />
			<If when={!props.compact}>
				<Text class="pr-1 text-faint" style={TYPE.body}>
					Search
				</Text>
				<KeyCap label={props.keys} />
			</If>
		</BaseButton>
	);
}
