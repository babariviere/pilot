// Popups: a value chosen from a list (the select), and a menu of commands. They share one popup frame.
import { type JSX, Text, View } from "nsh";
import { type Align, Menu as BaseMenu, MenuItem as BaseMenuItem, Select, type SelectItem } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { Icon, type IconName } from "./icon";
import { TYPE } from "./text";

/** The frame of every popup: a picker's list and a menu. */
const POPUP = "min-w-56 rounded-(--radius-panel) border border-border bg-popover p-1.5 shadow-md";

/**
 * The select: one value chosen from a list, such as a project or a model. Its trigger is 26 points high, framed like
 * a field, naming the choice with a chevron; its popup lists the items with a second line each (`detail`).
 * `searchable` adds a filter field for long lists. Choosing only reports the value; the caller decides what it does.
 * In a `Row` it sits in the trailing slot.
 */
export function Picker(props: {
	testID?: string;
	/** What the choice is about, for screen readers. */
	label: string;
	items: SelectItem[];
	value: string | null;
	/** What the trigger says while nothing listed is chosen. */
	placeholder: string;
	disabled?: boolean;
	searchable?: boolean;
	searchPlaceholder?: string;
	/** A quiet second line for an item, by value. */
	detail?: (value: string) => string;
	agent?: AgentMark;
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
}) {
	const title = () => props.items.find((i) => i.value === props.value)?.title ?? props.placeholder;
	const agent = useAgent({
		component: "select",
		label: () => props.label,
		id: () => props.testID,
		state: { value: () => props.value },
		items: () => props.items.map((i) => ({ value: i.value, label: i.title })),
		closed: true,
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: { setValue: (value) => props.onChange(String(value)) },
	});
	return (
		<Select
			ref={agent.anchor}
			testID={props.testID}
			items={props.items}
			value={props.value}
			disabled={props.disabled}
			searchable={props.searchable}
			searchPlaceholder={props.searchPlaceholder ?? null}
			searchAccessibilityLabel={props.searchPlaceholder ?? null}
			accessibilityLabel={props.label}
			offset={4}
			onChange={({ value }) => {
				if (value !== null) props.onChange(value);
			}}
			onOpenChange={({ open }) => props.onOpenChange?.(open)}
			class={`rounded-lg disabled:opacity-45 ${FOCUS_RING}`}
			popupClass={POPUP}
			listClass="max-h-72"
			itemClass="group rounded-lg px-2.5 py-1.5 focus:bg-accent selected:bg-selection disabled:opacity-50"
			searchClass="mb-1 rounded-lg border border-input bg-card px-2.5 py-1 text-foreground"
			renderItem={(item) => (
				<View>
					<Text class="text-popover-foreground" style={TYPE.body}>
						{item.title}
					</Text>
					<If when={props.detail?.(item.value)}>
						<Text class="text-faint" style={TYPE.caption}>
							{props.detail?.(item.value) ?? ""}
						</Text>
					</If>
				</View>
			)}
			trigger={
				<View class="h-6.5 flex-row items-center gap-2 rounded-lg border border-input bg-card pl-2.5 pr-1.5 hover:bg-accent">
					<Text class="shrink truncate text-foreground" style={TYPE.body}>
						{title()}
					</Text>
					<Icon name="chevron" tint="tint-faint" />
				</View>
			}
		/>
	);
}

/** A menu of commands under a trigger. The page owns whether it is open. */
export function Menu(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** How it lines up with the trigger (default `start`). */
	align?: Align;
	/** What opens it: a view with `role="button"`. */
	trigger: JSX.Element;
	/** The screen agent's name for the menu, such as its trigger's label. */
	agentLabel?: string;
	/** A `MenuTitle` and its `MenuItem`s. */
	children?: JSX.Element;
}) {
	const agent = useAgent({
		component: "menu",
		label: () => props.agentLabel,
		state: { open: () => props.open },
		actions: {
			setOpen: (open) => {
				if (open !== props.open) props.onOpenChange(open === true);
			},
		},
	});
	return (
		<BaseMenu
			ref={agent.anchor}
			open={props.open}
			onOpenChange={(e) => props.onOpenChange(e.open)}
			align={props.align}
			offset={4}
			popupClass={POPUP}
			trigger={props.trigger}
		>
			{props.children}
		</BaseMenu>
	);
}

/** A `Menu`'s trigger: an icon framed like an icon-only `Action`. The label names it for screen readers. */
export function MenuTrigger(props: {
	icon: IconName;
	accessibilityLabel: string;
	/** A short name, shown as a tooltip. */
	tooltip: string;
	testID?: string;
}) {
	return (
		<View
			testID={props.testID}
			role="button"
			accessibilityLabel={props.accessibilityLabel}
			tooltip={props.tooltip}
			class={`size-6.5 items-center justify-center rounded-lg hover:bg-accent active:bg-accent ${FOCUS_RING}`}
		>
			<Icon name={props.icon} />
		</View>
	);
}

/** What a `Menu`'s commands act on, as a quiet line above them. */
export function MenuTitle(props: { label: string }) {
	return (
		<Text class="px-2.5 pb-1 pt-1 text-faint" style={TYPE.caption}>
			{props.label}
		</Text>
	);
}

/** One command of a `Menu`: its words and a quiet `hint` at the right ("Shown now", a count). Choosing it closes the menu. */
export function MenuItem(props: {
	label: string;
	hint?: string;
	testID?: string;
	disabled?: boolean;
	agent?: AgentMark;
	onSelect: () => void;
}) {
	const agent = useAgent({
		component: "menuitem",
		label: () => props.label,
		id: () => props.testID,
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: { press: () => props.onSelect() },
	});
	return (
		<BaseMenuItem
			ref={agent.anchor}
			testID={props.testID}
			disabled={props.disabled}
			onSelect={props.onSelect}
			class="flex-row items-center gap-3 rounded-lg px-2.5 py-1.5 hover:bg-accent focus:bg-accent disabled:opacity-50"
		>
			<Text class="flex-1 text-popover-foreground" style={TYPE.body}>
				{props.label}
			</Text>
			<If when={props.hint}>
				<Text class="font-mono text-faint" style={TYPE.number}>
					{props.hint ?? ""}
				</Text>
			</If>
		</BaseMenuItem>
	);
}
