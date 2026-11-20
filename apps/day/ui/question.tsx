// The question: the one thing that waits for the user's answer. It leads its section and has no frame of its own:
// the panel is the frame. Other things that wait queue under it as `Row`s.
import { type JSX, View, type ViewRef } from "nsh";
import { Num, Title } from "./text";

/**
 * The thing that waits for an answer: its `title` (Title role) with its place in the queue (`position`, "1 of 2"),
 * a `meta` line (a plain `State` and captions: why it needs you, the mission, the effort), its body (sentences,
 * `Chip`s for help, `Options`, fields) and a `foot` (one Primary `Button`, a Secondary one, then `KeyHints`).
 * Padded to line up with its section's heading. Rule: one question shows at a time; the others are rows under it.
 */
export function Question(props: {
	title: string;
	titleTestID?: string;
	position?: string;
	meta?: JSX.Element;
	foot?: JSX.Element;
	testID?: string;
	anchor?: (node: ViewRef) => void;
	children?: JSX.Element;
}) {
	return (
		<View ref={props.anchor} testID={props.testID} class="gap-3.5 px-4 pb-3.5 pt-1.5">
			<View class="gap-1.5">
				<View class="flex-row items-baseline gap-3">
					<View class="min-w-0 flex-1">
						<Title testID={props.titleTestID} role="header">
							{props.title}
						</Title>
					</View>
					<If when={props.position}>
						<Num>{props.position ?? ""}</Num>
					</If>
				</View>
				<View class="flex-row flex-wrap items-center gap-x-1.5 gap-y-1">{props.meta}</View>
			</View>
			{props.children}
			<View class="flex-row flex-wrap items-center gap-2 pt-0.5">{props.foot}</View>
		</View>
	);
}
