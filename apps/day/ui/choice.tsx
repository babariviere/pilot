// Choosing: the options of a Question (one choice, or several with `multiple`). Each option is a ring or a box,
// then its words: a title, an optional tag ("Recommended") and a hint. The page owns which are chosen.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Checkbox, Radio, RadioGroup, Toggle } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { Icon } from "./icon";
import { TYPE } from "./text";

/**
 * The options of one choice: one stop of Tab, the arrows move between them. Options reach 12 points past the
 * Question's text on each side, so their rings line up with it. For picks that add up, use a plain `Options
 * multiple`: each `Option multiple` is its own stop.
 */
export function Options(props: { multiple?: boolean; testID?: string; children?: JSX.Element }) {
	return (
		<If
			when={props.multiple}
			else={
				<RadioGroup testID={props.testID} class="-mx-3 gap-0.5">
					{props.children}
				</RadioGroup>
			}
		>
			<View testID={props.testID} class="-mx-3 gap-0.5">
				{props.children}
			</View>
		</If>
	);
}

/** An option's words: its title, its tag and its hint, or richer content. */
function Words(props: { title?: string; tag?: string; hint?: string; children?: JSX.Element }) {
	return (
		<If
			when={props.children}
			else={
				<View class="min-w-0 flex-1 gap-0.5">
					<View class="flex-row flex-wrap items-center gap-2">
						<Text class="text-foreground" style={TYPE.bodyStrong}>
							{props.title ?? ""}
						</Text>
						<If when={props.tag}>
							<OptionTag label={props.tag ?? ""} />
						</If>
					</View>
					<If when={props.hint}>
						<Text class="text-muted-foreground" style={TYPE.caption}>
							{props.hint ?? ""}
						</Text>
					</If>
				</View>
			}
		>
			{props.children}
		</If>
	);
}

/** The small tag after an option's title, such as "Recommended" or "Suggested". */
export function OptionTag(props: { label: string }) {
	return (
		<View class="rounded-md bg-muted px-1.5 group-checked:bg-card group-aria-checked:bg-card">
			<Text class="text-muted-foreground" style={{ fontSize: 11, lineHeight: 16, fontWeight: "500" }}>
				{props.label}
			</Text>
		</View>
	);
}

const OPTION = `group flex-row items-start gap-2.5 rounded-lg px-3 py-2 hover:bg-accent disabled:opacity-60 ${FOCUS_RING}`;
const COMPACT = `group flex-row items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-accent disabled:opacity-60 ${FOCUS_RING}`;

/** The ring of a one-choice option. Its `group-checked:` classes follow the option. */
function Ring() {
	return (
		<View class="mt-px size-4 items-center justify-center rounded-full border-[1.5px] border-input group-checked:border-primary">
			<View class="size-2 rounded-full group-checked:bg-primary" />
		</View>
	);
}

/**
 * One option of a Question: a ring (or a box with `multiple`), then its `title`, `tag` and `hint` (or richer
 * `children`). The chosen option is filled. `compact` draws a one-line option for short lists outside a Question.
 */
export function Option(props: {
	title?: string;
	tag?: string;
	hint?: string;
	checked: boolean;
	/** A box that adds up with other picks instead of a ring that replaces them. */
	multiple?: boolean;
	compact?: boolean;
	disabled?: boolean;
	testID?: string;
	/** The test id of the tick, shown only while a `multiple` option is checked. */
	tickTestID?: string;
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: () => void;
	children?: JSX.Element;
}) {
	const agent = useAgent({
		component: props.multiple ? "checkbox" : "radio",
		label: () => props.accessibilityLabel ?? props.title,
		id: () => props.testID,
		state: { checked: () => props.checked },
		disabled: () => props.disabled,
		mark: () => props.agent,
		actions: props.multiple
			? {
					setChecked: (on) => {
						if (on !== props.checked) props.onChange();
					},
					toggle: () => props.onChange(),
				}
			: {
					select: () => {
						if (!props.checked) props.onChange();
					},
				},
	});
	const anchor = (node: ViewRef) => {
		agent.anchor(node);
		props.anchor?.(node);
	};
	const look = () => `${props.compact ? COMPACT : OPTION} checked:bg-selection checked:hover:bg-selection`;
	return (
		<If
			when={props.multiple}
			else={
				<Radio
					ref={anchor}
					testID={props.testID}
					checked={props.checked}
					disabled={props.disabled}
					accessibilityLabel={props.accessibilityLabel ?? null}
					onChange={props.onChange}
					class={look()}
				>
					<Ring />
					<Words title={props.title} tag={props.tag} hint={props.hint}>
						{props.children}
					</Words>
				</Radio>
			}
		>
			<Checkbox
				ref={anchor}
				testID={props.testID}
				checked={props.checked}
				disabled={props.disabled}
				accessibilityLabel={props.accessibilityLabel ?? null}
				onChange={props.onChange}
				class={look()}
				indicatorClass="mt-px size-4 items-center justify-center rounded border-[1.5px] border-input checked:border-primary checked:bg-primary"
				indicator={
					<If when={props.checked}>
						<View testID={props.tickTestID}>
							<Icon name="check" tint="tint-primary-foreground" />
						</View>
					</If>
				}
			>
				<Words title={props.title} tag={props.tag} hint={props.hint}>
					{props.children}
				</Words>
			</Checkbox>
		</If>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Older shapes, kept while screens move.

/** @deprecated `md` is `Option compact`, `lg` is `Option`. */
export type ChoiceSize = "md" | "lg";

/** @deprecated Use `Options`. */
export function RadioList(props: { children?: JSX.Element }) {
	return <RadioGroup class="gap-0.5">{props.children}</RadioGroup>;
}

/** @deprecated Use `Option` (`size="md"` is `compact`). */
export function RadioRow(props: {
	testID?: string;
	label?: string;
	checked: boolean;
	disabled?: boolean;
	size?: ChoiceSize;
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: () => void;
	children?: JSX.Element;
}) {
	return (
		<Option
			title={props.label}
			checked={props.checked}
			compact={props.size !== "lg"}
			disabled={props.disabled}
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			anchor={props.anchor}
			agent={props.agent}
			onChange={props.onChange}
		>
			{props.children}
		</Option>
	);
}

/** @deprecated Use `Option multiple` (in a Question) or `Checkbox` (elsewhere). */
export function CheckboxRow(props: {
	testID?: string;
	label?: string;
	checked: boolean;
	disabled?: boolean;
	size?: ChoiceSize;
	tickTestID?: string;
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	onChange: () => void;
	children?: JSX.Element;
}) {
	return (
		<Option
			multiple
			title={props.label}
			checked={props.checked}
			compact={props.size !== "lg"}
			disabled={props.disabled}
			testID={props.testID}
			tickTestID={props.tickTestID}
			accessibilityLabel={props.accessibilityLabel}
			anchor={props.anchor}
			agent={props.agent}
			onChange={props.onChange}
		>
			{props.children}
		</Option>
	);
}

/**
 * A ring or a box that shows a pick, for a `ToggleRow`'s `indicator`.
 * @deprecated Use `Option`, which draws its own ring or box.
 */
export function PickMark(props: { shape: "radio" | "checkbox"; checked: boolean }) {
	return (
		<View
			class={`mt-px size-4 items-center justify-center border-[1.5px] ${props.shape === "radio" ? "rounded-full" : "rounded"} ${props.checked ? "border-primary" : "border-input"}`}
		>
			<View
				class={`size-2 ${props.shape === "radio" ? "rounded-full" : "rounded-sm"} ${props.checked ? "bg-primary" : ""}`}
			/>
		</View>
	);
}

/**
 * A row that turns a pick on and off, for options outside a radio set: its `indicator`, then its content.
 * @deprecated Use `Option` (or `Option multiple`).
 */
export function ToggleRow(props: {
	testID?: string;
	pressed: boolean;
	disabled?: boolean;
	size?: ChoiceSize;
	accessibilityLabel?: string;
	anchor?: (node: ViewRef) => void;
	agent?: AgentMark;
	indicator: JSX.Element;
	onChange: () => void;
	children?: JSX.Element;
}) {
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
			class={`${props.size === "lg" ? OPTION : COMPACT} aria-pressed:bg-selection aria-pressed:hover:bg-selection`}
		>
			{props.indicator}
			{props.children}
		</Toggle>
	);
}
