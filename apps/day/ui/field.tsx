// Fields: the text field, a labelled field with its help, a switch and a checkbox. The page owns every value.
import { split, Text, View, type ViewRef } from "nsh";
import { Checkbox as BaseCheckbox, Switch as BaseSwitch, Input, type InputProps } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { Icon } from "./icon";
import { TYPE } from "./text";

/** A labeled, read-only fact. Evidence is separate from its value and from editable inputs. */
export function ReadField(props: { label: string; value: string; evidence?: string }) {
	return (
		<View class="min-w-60 flex-1 gap-1.5">
			<Text class="text-foreground" style={TYPE.control}>
				{props.label}
			</Text>
			<View selectable class="rounded-lg border border-border bg-muted px-2.5 py-1.5">
				<Text class="text-foreground" style={TYPE.bodyStrong}>
					{props.value}
				</Text>
			</View>
			<If when={props.evidence}>
				<Text class="text-muted-foreground" style={TYPE.caption}>
					{props.evidence}
				</Text>
			</If>
		</View>
	);
}

/**
 * How a `TextField` looks. `field` (the default) is a form's box, 26 points high; `composer` is the bare text area
 * inside a `Composer` (the composer draws the frame); `title` edits a page title in the Display size.
 */
export type TextFieldVariant = "field" | "composer" | "title";

/** The lines a multiline `TextField` shows before it grows, by its `rows`. */
const MIN_HEIGHT = {
	1: "",
	2: "min-h-12",
	3: "min-h-16",
	4: "min-h-20",
	5: "min-h-24",
	8: "min-h-36",
} as const;

/** How many lines a `TextField` shows before it grows. */
export type TextFieldRows = keyof typeof MIN_HEIGHT;

const FRAME: Record<TextFieldVariant, string> = {
	field: "min-h-6.5 rounded-lg border px-2.5 py-1 bg-card",
	composer: "min-h-10 border-0 bg-transparent p-0",
	title: "min-h-9 rounded-lg border px-2.5 py-1 bg-card",
};

/**
 * The one text box, over the base `Input`: every `Input` prop passes through. 26 points high, radius 8, a strong
 * hairline that turns accent while focused and red while `invalid`. Rule: a field's label sits above it or leads its
 * row; an error takes the help line's place (`Field` does both).
 */
export function TextField(
	props: Omit<InputProps, "class" | "style"> & {
		/** The look (default `field`). */
		variant?: TextFieldVariant;
		/** The lines it shows before it grows (default 1). */
		rows?: TextFieldRows;
		/** @deprecated Every field is 26 points high now; `compact` changes nothing. */
		compact?: boolean;
		/** @deprecated Every field uses the body size now; `large` changes nothing. */
		large?: boolean;
		/** Draws the frame red: the value cannot be used. Say why in the help line. */
		invalid?: boolean;
		/** Layout classes only, such as `flex-1`. */
		class?: string;
		/** What the screen agent must know: `secret` hides the value (masked fields always are). */
		agent?: AgentMark;
	},
) {
	const [own, rest] = split(props, ["variant", "rows", "compact", "large", "invalid", "class", "agent", "ref"]);
	const agent = useAgent({
		component: "input",
		label: () => rest.accessibilityLabel ?? rest.placeholder,
		id: () => rest.testID,
		state: { value: () => rest.value ?? "" },
		mark: () => (rest.masked ? { ...own.agent, secret: true } : own.agent),
		actions: {
			setValue: (value) => rest.onChange?.({ value: String(value) }),
			clear: () => rest.onChange?.({ value: "" }),
		},
	});
	const border = () => (own.invalid ? "border-failed" : "border-input focus:border-primary");
	return (
		<Input
			{...rest}
			ref={(node) => {
				agent.anchor(node);
				if (typeof own.ref === "function") own.ref(node);
			}}
			class={`text-foreground placeholder:text-faint ${FRAME[own.variant ?? "field"]} ${border()} ${MIN_HEIGHT[own.rows ?? 1]} ${own.class ?? ""}`}
			style={own.variant === "title" ? TYPE.title : TYPE.body}
		/>
	);
}

/**
 * A labelled single-line field: the label above, the field, then a help line under it. An `error` takes the help
 * line's place and draws the field red. The page owns the value.
 */
export function Field(props: {
	label: string;
	value: string;
	masked?: boolean;
	placeholder?: string;
	/** One quiet line under the field: what it is for. */
	help?: string;
	/** Why the value cannot be used. It replaces `help`. */
	error?: string;
	testID?: string;
	/** The lines it shows; more than one makes it multiline. */
	rows?: TextFieldRows;
	onChange: (value: string) => void;
}) {
	return (
		<View class="gap-1.5">
			<Text class="text-foreground" style={TYPE.control}>
				{props.label}
			</Text>
			<TextField
				masked={props.masked}
				multiline={(props.rows ?? 1) > 1}
				rows={props.rows}
				autoCorrect={false}
				autoCapitalize="none"
				testID={props.testID}
				accessibilityLabel={props.label}
				value={props.value}
				placeholder={props.placeholder}
				invalid={!!props.error}
				onChange={({ value }) => props.onChange(value)}
			/>
			<If when={props.error || props.help}>
				<Text class={props.error ? "text-failed-ink" : "text-muted-foreground"} style={TYPE.caption}>
					{props.error || props.help || ""}
				</Text>
			</If>
		</View>
	);
}

/**
 * A switch for a setting that takes effect at once: 34 by 20, accent while on. It sits in a `Row`'s trailing slot;
 * the row's title is its label, so pass the same words as `accessibilityLabel`.
 */
export function Switch(props: {
	checked: boolean;
	accessibilityLabel: string;
	disabled?: boolean;
	testID?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: (checked: boolean) => void;
}) {
	const agent = useAgent({
		component: "switch",
		label: () => props.accessibilityLabel,
		id: () => props.testID,
		state: { checked: () => props.checked },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: {
			setChecked: (on) => {
				if (on !== props.checked) props.onChange(on === true);
			},
			toggle: () => props.onChange(!props.checked),
		},
	});
	return (
		<BaseSwitch
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			checked={props.checked}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel}
			onChange={({ checked }) => props.onChange(checked)}
			class={`rounded-full disabled:opacity-45 ${FOCUS_RING}`}
			trackClass="h-5 w-8.5 justify-center rounded-full bg-border-strong px-0.5 checked:bg-primary"
			thumbClass="size-4 rounded-full bg-card shadow-sm checked:translate-x-3.5"
		/>
	);
}

/**
 * A checkbox with its words beside it ("Lighthouse"), for a pick that adds up with others outside a Question. In a
 * Question, use `Option multiple`.
 */
export function Checkbox(props: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	testID?: string;
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: (checked: boolean) => void;
}) {
	const agent = useAgent({
		component: "checkbox",
		label: () => props.accessibilityLabel ?? props.label,
		id: () => props.testID,
		state: { checked: () => props.checked },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: {
			setChecked: (on) => {
				if (on !== props.checked) props.onChange(on === true);
			},
			toggle: () => props.onChange(!props.checked),
		},
	});
	return (
		<BaseCheckbox
			ref={(node: ViewRef) => {
				agent.anchor(node);
				props.anchor?.(node);
			}}
			testID={props.testID}
			checked={props.checked}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? null}
			onChange={({ checked }) => props.onChange(checked)}
			class={`flex-row items-center gap-2 self-start rounded-md disabled:opacity-45 ${FOCUS_RING}`}
			indicatorClass="size-4 items-center justify-center rounded border-[1.5px] border-input checked:border-primary checked:bg-primary"
			indicator={
				<If when={props.checked}>
					<Icon name="check" tint="tint-primary-foreground" />
				</If>
			}
		>
			<Text class="text-foreground" style={TYPE.control}>
				{props.label}
			</Text>
		</BaseCheckbox>
	);
}
