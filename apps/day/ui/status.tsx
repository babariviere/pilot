// State marks and the notices built on them. A mark is a still dot whose
// words beside it carry the meaning; a notice is a quiet panel that says
// what could not be read or confirmed, and what the user can do.
import { type JSX, Text, View } from "nsh";
import { Icon } from "./icon";
import { Panel } from "./layout";

/** A still state mark. Words beside it carry the meaning. */
export type MarkKind =
	| "needs"
	| "failed"
	| "ready"
	| "unknown"
	| "moving"
	| "still"
	| "paused"
	| "unreported"
	| "oldReport"
	| "done"
	| "new";

const MARKS: Record<MarkKind, string> = {
	oldReport: "",
	needs: "bg-needs",
	failed: "bg-failed",
	ready: "bg-ok",
	done: "bg-faint",
	unknown: "border-2 border-needs",
	moving: "border-2 border-faint",
	still: "bg-faint",
	paused: "bg-faint",
	unreported: "border border-dashed border-faint",
	// A request that came in and nobody started: present, not urgent.
	new: "bg-muted-foreground",
};

/** A small round mark for a state. */
export function Mark(props: { kind: MarkKind }) {
	return (
		<If
			when={props.kind === "oldReport"}
			else={<View class={`size-2 rounded-full transition-colors duration-200 ${MARKS[props.kind]}`} />}
		>
			<Icon name="document" tint="tint-muted-foreground" />
		</If>
	);
}

/**
 * A mark beside content that may wrap: the mark sits on the first line's middle. The content fills the rest of
 * the row.
 */
export function MarkLine(props: {
	kind: MarkKind;
	testID?: string;
	/** Lets the user select and copy the content. */
	selectable?: boolean;
	children?: JSX.Element;
}) {
	return (
		<View testID={props.testID} class="flex-row items-start gap-2.5">
			<View class="pt-1.5">
				<Mark kind={props.kind} />
			</View>
			<View selectable={props.selectable} class="min-w-0 flex-1 gap-0.5">
				{props.children}
			</View>
		</View>
	);
}

/**
 * A quiet panel that says one thing about the page's state, such as a read that failed or an answer not
 * confirmed: a mark and its words, an optional command at the line's end (`action`), a quieter `detail` line,
 * then anything else below (`children`).
 */
export function Notice(props: {
	text: string;
	/** The mark (default `unknown`). */
	kind?: MarkKind;
	detail?: string;
	testID?: string;
	/** `alert` makes screen readers say it as soon as it shows. */
	role?: "alert";
	/** A command at the end of the line, such as Check or Read again. */
	action?: JSX.Element;
	/** Layout classes only, such as a margin. */
	class?: string;
	children?: JSX.Element;
}) {
	return (
		<Panel testID={props.testID} class={`gap-1.5 ${props.class ?? ""}`}>
			<View class="flex-row items-center gap-2.5">
				<Mark kind={props.kind ?? "unknown"} />
				<Text role={props.role} class="flex-1 text-sm text-foreground">
					{props.text}
				</Text>
				{props.action}
			</View>
			<If when={props.detail}>
				<Text class="text-xs text-faint">{props.detail ?? ""}</Text>
			</If>
			{props.children}
		</Panel>
	);
}
