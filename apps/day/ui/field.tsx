// Text entry. `TextField` is the app's one text box, in a few sizes and
// looks; `Field` adds a label above it. The page owns every value.
import { split, Text, View } from "nsh";
import { Input, type InputProps } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";

/** A labeled, read-only fact. Evidence is separate from its value and from editable inputs. */
export function ReadField(props: { label: string; value: string; evidence?: string }) {
	return (
		<View class="min-w-60 flex-1 gap-2">
			<Text class="text-sm font-medium text-foreground">{props.label}</Text>
			<View selectable class="rounded-lg border border-border bg-muted p-3">
				<Text class="text-base font-semibold text-foreground">{props.value}</Text>
			</View>
			<If when={props.evidence}>
				<Text class="text-xs text-muted-foreground">{props.evidence}</Text>
			</If>
		</View>
	);
}

/**
 * How a `TextField` looks. `field` (the default) is a form's box; `composer` is the larger, rounder box a message
 * is written in; `title` edits a page title in the title's own size.
 */
export type TextFieldVariant = "field" | "composer" | "title";

/** The lines a multiline `TextField` shows before it grows, by its `rows`. */
const MIN_HEIGHT = {
	1: "",
	2: "min-h-16",
	3: "min-h-20",
	4: "min-h-24",
	5: "min-h-28",
	8: "min-h-40",
} as const;

/** How many lines a `TextField` shows before it grows. */
export type TextFieldRows = keyof typeof MIN_HEIGHT;

const FRAME: Record<TextFieldVariant, string> = {
	field: "min-h-9 rounded-lg px-3 py-2",
	composer: "min-h-20 rounded-xl px-3.5 py-2.5",
	title: "min-h-11 rounded-lg px-3 py-1.5",
};

/**
 * One text box over the base `Input`: every `Input` prop passes through. `compact` makes a one-line field as
 * tall as an `Action`, to sit beside it.
 */
export function TextField(
	props: Omit<InputProps, "class" | "style"> & {
		/** The look (default `field`). */
		variant?: TextFieldVariant;
		/** The lines it shows before it grows (default 1). */
		rows?: TextFieldRows;
		/** As tall as an `Action` (32 points) rather than 36. */
		compact?: boolean;
		/** Larger words, for the main thing a screen asks for. */
		large?: boolean;
		/** Layout classes only, such as `flex-1`. */
		class?: string;
		/** What the screen agent must know: `secret` hides the value (masked fields always are). */
		agent?: AgentMark;
	},
) {
	const [own, rest] = split(props, ["variant", "rows", "compact", "large", "class", "agent", "ref"]);
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
	const frame = () => (own.compact ? "min-h-8 rounded-lg px-3 py-1.5" : FRAME[own.variant ?? "field"]);
	const words = () => {
		if (own.variant === "title") return "text-2xl font-semibold tracking-tight";
		return own.large ? "text-base" : "text-sm";
	};
	return (
		<Input
			{...rest}
			ref={(node) => {
				agent.anchor(node);
				if (typeof own.ref === "function") own.ref(node);
			}}
			class={`border border-input bg-background text-foreground focus:border-primary ${frame()} ${words()} ${MIN_HEIGHT[own.rows ?? 1]} ${own.class ?? ""}`}
		/>
	);
}

/** A labelled single-line settings field. The page owns its value. */
export function Field(props: {
	label: string;
	value: string;
	masked?: boolean;
	placeholder?: string;
	testID?: string;
	/** The lines it shows; more than one makes it multiline. */
	rows?: TextFieldRows;
	onChange: (value: string) => void;
}) {
	return (
		<View class="gap-1.5">
			<Text class="text-sm text-foreground">{props.label}</Text>
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
				onChange={({ value }) => props.onChange(value)}
			/>
		</View>
	);
}
