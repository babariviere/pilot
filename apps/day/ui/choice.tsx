// Choosing among options: radio rows for one choice, checkbox rows for
// several, and toggle rows when a row turns a pick on and off. Each row is
// its indicator, then its words. The page owns which are chosen.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Checkbox, Radio, RadioGroup, Toggle } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";

/** A choice row's size: `md` for settings and short lists, `lg` for a decision's options. */
export type ChoiceSize = "md" | "lg";

const ROW: Record<ChoiceSize, string> = {
	md: "flex-row items-center gap-2.5 rounded-lg px-2 py-1.5",
	lg: "flex-row items-start gap-3 rounded-xl px-3 py-2.5",
};
/** A toggle row's indicator is a mark (top-aligned for wrapping words) or a key cap (centred on one line). */
const TOGGLE_ROW: Record<ChoiceSize, string> = {
	md: "flex-row items-start gap-2.5 rounded-lg px-2 py-1.5",
	lg: "flex-row items-center gap-3 rounded-xl px-3 py-2.5",
};
const ROW_STATES = `hover:bg-accent disabled:opacity-70 ${FOCUS_RING}`;

/** The radio's ring and dot, by size. Its `group-checked:` classes follow the row. */
function RadioDot(props: { size: ChoiceSize }) {
	return (
		<View
			class="items-center justify-center rounded-full border border-input group-checked:border-primary"
			classList={{ "size-3.5": props.size === "md", "mt-0.5 size-4": props.size === "lg" }}
		>
			<View
				class="rounded-full group-checked:bg-primary"
				classList={{ "size-1.5": props.size === "md", "size-2": props.size === "lg" }}
			/>
		</View>
	);
}

/** The words of a choice row, or its own content. */
function Words(props: { label?: string; children?: JSX.Element }) {
	return (
		<If when={props.children} else={<Text class="text-sm text-foreground">{props.label ?? ""}</Text>}>
			{props.children}
		</If>
	);
}

/** The set a `RadioRow` belongs to: one stop of Tab, arrows move between its rows. */
export function RadioList(props: { children?: JSX.Element }) {
	return <RadioGroup class="gap-0.5">{props.children}</RadioGroup>;
}

/** One choice of a `RadioList`: a ring, then its words (`label`, or richer `children`). */
export function RadioRow(props: {
	testID?: string;
	label?: string;
	checked: boolean;
	disabled?: boolean;
	/** The size (default `md`). */
	size?: ChoiceSize;
	accessibilityLabel?: string;
	/** Hears the row's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: () => void;
	children?: JSX.Element;
}) {
	const size = (): ChoiceSize => props.size ?? "md";
	const agent = useAgent({
		component: "radio",
		label: () => props.accessibilityLabel ?? props.label,
		id: () => props.testID,
		state: { checked: () => props.checked },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: {
			select: () => {
				if (!props.checked) props.onChange();
			},
		},
	});
	return (
		<Radio
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			checked={props.checked}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? null}
			onChange={props.onChange}
			class={`group ${ROW[size()]} checked:bg-selection checked:hover:bg-selection ${ROW_STATES}`}
		>
			<RadioDot size={size()} />
			<Words label={props.label}>{props.children}</Words>
		</Radio>
	);
}

/** One option the user may tick with others: a box, then its words (`label`, or richer `children`). */
export function CheckboxRow(props: {
	testID?: string;
	label?: string;
	checked: boolean;
	disabled?: boolean;
	/** The size (default `md`). */
	size?: ChoiceSize;
	/** The test id of the tick, shown only while checked. */
	tickTestID?: string;
	accessibilityLabel?: string;
	/** Hears the row's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: () => void;
	children?: JSX.Element;
}) {
	const size = (): ChoiceSize => props.size ?? "md";
	const agent = useAgent({
		component: "checkbox",
		label: () => props.accessibilityLabel ?? props.label,
		id: () => props.testID,
		state: { checked: () => props.checked },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: {
			setChecked: (on) => {
				if (on !== props.checked) props.onChange();
			},
			toggle: () => props.onChange(),
		},
	});
	return (
		<Checkbox
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			checked={props.checked}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? null}
			onChange={props.onChange}
			class={`${ROW[size()]} checked:bg-selection checked:hover:bg-selection ${ROW_STATES}`}
			indicatorClass={`size-4 items-center justify-center rounded border border-input checked:border-primary checked:bg-primary ${size() === "lg" ? "mt-0.5" : ""}`}
			indicator={
				<If when={props.checked}>
					<View testID={props.tickTestID} class="size-2 rounded-sm bg-primary-foreground" />
				</If>
			}
		>
			<Words label={props.label}>{props.children}</Words>
		</Checkbox>
	);
}

/** A ring or a box that shows a pick, for a `ToggleRow`'s `indicator`. */
export function PickMark(props: {
	/** `radio` when one pick replaces another, `checkbox` when picks add up. */
	shape: "radio" | "checkbox";
	checked: boolean;
}) {
	return (
		<View
			class="mt-1 size-3.5 items-center justify-center border"
			classList={{
				"rounded-full": props.shape === "radio",
				"rounded-sm": props.shape === "checkbox",
				"border-primary": props.checked,
				"border-input": !props.checked,
			}}
		>
			<View class="size-1.5" classList={{ "rounded-full": props.shape === "radio", "bg-primary": props.checked }} />
		</View>
	);
}

/**
 * A row that turns a pick on and off, for options outside a radio set: its `indicator` (a `PickMark`, a
 * `KeyCap`), then its content. Its children's `group-aria-pressed:` classes follow it.
 */
export function ToggleRow(props: {
	testID?: string;
	pressed: boolean;
	disabled?: boolean;
	/** The size (default `md`). */
	size?: ChoiceSize;
	accessibilityLabel?: string;
	/** Hears the row's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	indicator: JSX.Element;
	onChange: () => void;
	children?: JSX.Element;
}) {
	const size = (): ChoiceSize => props.size ?? "md";
	const agent = useAgent({
		component: "toggle",
		label: () => props.accessibilityLabel,
		id: () => props.testID,
		state: { pressed: () => props.pressed },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: {
			setPressed: (on) => {
				if (on !== props.pressed) props.onChange();
			},
			toggle: () => props.onChange(),
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
			accessibilityLabel={props.accessibilityLabel ?? null}
			onChange={props.onChange}
			class={`group ${TOGGLE_ROW[size()]} aria-pressed:bg-selection aria-pressed:hover:bg-selection ${ROW_STATES}`}
		>
			{props.indicator}
			{props.children}
		</Toggle>
	);
}
