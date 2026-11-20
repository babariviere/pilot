// A notice: one problem, said beside the thing it affects, with one way out.
import { type JSX, Text, View } from "nsh";
import { useAgent } from "./agent";
import { Mark, type MarkKind } from "./state";
import { TYPE } from "./text";

/**
 * Where a notice sits. `panel`: full width at the top of a `Panel` (its `notice` prop), square, with a hairline
 * under it. `section`: inside a section, inset to its rows. `flow` (default): in page flow, for screens that have
 * not moved to a Panel yet.
 */
export type NoticePlacement = "panel" | "section" | "flow";

/**
 * One problem and one way out: a mark, the words, a quieter `detail` line and at most one `action` (a `Link` or a
 * small `Button`) at the end. Amber when the user can act (`needs`, the default), red when something failed
 * (`failed`). Rule: one problem per notice; it never blanks what is shown, and a read that failed says so here
 * rather than showing an empty list.
 */
export function Notice(props: {
	text: string;
	/** The mark: `needs` (default) or `failed`. Older kinds are accepted while screens move. */
	kind?: MarkKind;
	detail?: string;
	testID?: string;
	/** `alert` makes screen readers say it as soon as it shows. */
	role?: "alert";
	/** The one way out: a `Link` ("Try now", "Sign in") or a small `Button`. */
	action?: JSX.Element;
	placement?: NoticePlacement;
	/** @deprecated Layout classes from older screens. A placement replaces them. */
	class?: string;
	/** @deprecated Anything below the detail. A notice holds one problem and one way out; move the rest out. */
	children?: JSX.Element;
}) {
	const agent = useAgent({
		component: "status",
		label: () => props.text,
		id: () => props.testID,
		text: () => props.detail,
		actions: {},
	});
	const kind = (): MarkKind => (props.kind === "unknown" || !props.kind ? "needs" : props.kind);
	const fill = () => (kind() === "failed" ? "bg-failed-soft" : kind() === "needs" ? "bg-needs-soft" : "bg-muted");
	const frame = () => {
		if (props.placement === "panel") return "border-b border-border px-4 py-2.5";
		if (props.placement === "section") return "mx-3 my-1.5 rounded-xl px-3.5 py-2.5";
		return "rounded-xl px-3.5 py-2.5";
	};
	return (
		<View ref={agent.anchor} testID={props.testID} class={`${fill()} ${frame()} ${props.class ?? ""}`}>
			<View class="flex-row items-start gap-2.5">
				<View class="h-4.5 w-3.5 items-center justify-center">
					<Mark kind={props.kind ?? "unknown"} />
				</View>
				<View class="min-w-0 flex-1">
					<Text role={props.role} class="text-foreground" style={TYPE.body}>
						{props.text}
					</Text>
					<If when={props.detail}>
						<Text class="text-muted-foreground" style={TYPE.caption}>
							{props.detail ?? ""}
						</Text>
					</If>
				</View>
				<View class="shrink-0 flex-row items-center self-center">{props.action}</View>
			</View>
			<View class="gap-1.5 pl-6">{props.children}</View>
		</View>
	);
}
