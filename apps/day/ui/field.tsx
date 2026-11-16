// Text entry. `TextField` is the app's one text box, in a few sizes and
// looks; `Field` adds a label above it. The page owns every value.
import { split, Text, View } from "nsh";
import { Input, type InputProps } from "nsh/base";

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
	},
) {
	const [own, rest] = split(props, ["variant", "rows", "compact", "large", "class"]);
	const frame = () => (own.compact ? "min-h-8 rounded-lg px-3 py-1.5" : FRAME[own.variant ?? "field"]);
	const words = () => {
		if (own.variant === "title") return "text-2xl font-semibold tracking-tight";
		return own.large ? "text-base" : "text-sm";
	};
	return (
		<Input
			{...rest}
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
