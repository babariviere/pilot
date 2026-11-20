// Choosing: the options of a Question (one choice, or several with `multiple`). Each option is a ring or a box,
// then its words: a title, an optional tag ("Recommended") and a hint. The page owns which are chosen.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Button as BaseButton, Checkbox, Radio, RadioGroup } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { Icon } from "./icon";
import { TYPE } from "./text";

/**
 * The options of one choice: one stop of Tab, the arrows move between them. Options reach 12 points past the
 * Question's text on each side, so their rings line up with it. For picks that add up, use a plain `Options
 * multiple`: each `Option multiple` is its own stop. `Option clearable` options also go in `Options multiple`.
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

/** The ring of a one-choice option. Its `group-checked:` classes follow the option, or `on` says it. */
function Ring(props: { on?: boolean }) {
	return (
		<View
			class={`mt-px size-4 items-center justify-center rounded-full border-[1.5px] ${props.on === undefined ? "border-input group-checked:border-primary" : props.on ? "border-primary" : "border-input"}`}
		>
			<View
				class={`size-2 rounded-full ${props.on === undefined ? "group-checked:bg-primary" : props.on ? "bg-primary" : ""}`}
			/>
		</View>
	);
}

/**
 * One option of a Question: a ring (or a box with `multiple`), then its `title`, `tag` and `hint` (or richer
 * `children`). The chosen option is filled. `compact` draws a one-line option for short lists outside a Question.
 * `clearable` is a one-choice option that clears when pressed again and is its own Tab stop (a suggestion the user
 * may take back); put clearable options in `Options multiple`.
 */
export function Option(props: {
	title?: string;
	tag?: string;
	hint?: string;
	checked: boolean;
	/** A box that adds up with other picks instead of a ring that replaces them. */
	multiple?: boolean;
	/** A ring that clears on a second press; its own Tab stop. */
	clearable?: boolean;
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
	// A clearable option is its own press target; `clearable` is chosen once, when the option is made.
	if (props.clearable)
		return (
			<BaseButton
				ref={anchor}
				testID={props.testID}
				selected={props.checked}
				disabled={props.disabled}
				accessibilityLabel={props.accessibilityLabel ?? null}
				onPress={props.onChange}
				class={`${props.compact ? COMPACT : OPTION} ${props.checked ? "bg-selection hover:bg-selection" : ""}`}
			>
				<Ring on={props.checked} />
				<Words title={props.title} tag={props.tag} hint={props.hint}>
					{props.children}
				</Words>
			</BaseButton>
		);
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
