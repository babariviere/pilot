// The page's frame: its centred column and its head. A page is a PageHead, then one Panel with its tabs.
import { type JSX, Text, View, type ViewRef, windowSize } from "nsh";
import { Pill } from "./state";
import { Display, TYPE } from "./text";

/** Below this window width a page uses narrow side padding, stacks its head and stacks a panel's columns. */
export const NARROW = 880;

/** Whether the window is narrow (see `NARROW`). Reactive. */
export function narrow(): boolean {
	return windowSize().width < NARROW;
}

/** The page widths: one panel at most 1088 points wide (1040 inside the padding), 840 for a form such as Settings. */
const WIDTH = { page: 1088, form: 840 } as const;

const PAGE_GAP = { 0: "gap-0", 4: "gap-4", 8: "gap-8", 10: "gap-10", 12: "gap-12" } as const;

/**
 * A page's centred column, inside the screen's `Scroll`: at most 1088 points wide (`width="form"`: 840), 24 points
 * at the sides (12 in a narrow window), 30 above. It holds a `PageHead`, then one `Panel`. Rule: one panel per page;
 * the page sets no colours and no look of its own.
 */
export function Page(props: {
	testID?: string;
	/** `page` (default) or `form` for a settings-like page. */
	width?: keyof typeof WIDTH;
	/**
	 * The space between children (Tailwind's scale). New pages leave it at 0: the head and the panel space
	 * themselves. Older screens pass their own while they move.
	 */
	gap?: keyof typeof PAGE_GAP;
	children?: JSX.Element;
}) {
	return (
		<View
			testID={props.testID}
			class={`w-full self-center pb-24 pt-7.5 ${narrow() ? "px-3" : "px-6"} ${PAGE_GAP[props.gap ?? 0]}`}
			style={{ maxWidth: WIDTH[props.width ?? "page"] }}
		>
			{props.children}
		</View>
	);
}

/**
 * A page's head: a quiet line above the title (`pre`: a date, a project), the title (Display), the page's state
 * beside it, one or two sentences (`text`), and the page's actions at the right (stacked under it in a narrow
 * window). Rule: the title says what matters now in one line; actions here are Secondary buttons.
 */
export function PageHead(props: {
	title: string;
	/** The title's test ID. */
	titleTestID?: string;
	testID?: string;
	/** A quiet line above the title, such as the date (use `Num` or `Caption`). */
	pre?: JSX.Element;
	/** The page's state beside the title (a `State`). */
	state?: JSX.Element;
	/** One or two sentences under the title. */
	text?: string;
	/** Anything else under the text: a quiet note, a notice about the whole page. */
	children?: JSX.Element;
	/** Buttons at the right: Secondary `Button`s, a `Select`. */
	actions?: JSX.Element;
}) {
	return (
		<View testID={props.testID} class={`px-1 pb-5 ${narrow() ? "gap-3" : "flex-row items-start gap-6"}`}>
			<View class="min-w-0 flex-1 gap-1.5">
				{props.pre}
				<View class="flex-row flex-wrap items-center gap-2.5">
					<Display testID={props.titleTestID} role="header">
						{props.title}
					</Display>
					{props.state}
				</View>
				<If when={props.text}>
					<Text class="max-w-xl text-muted-foreground" style={TYPE.body}>
						{props.text ?? ""}
					</Text>
				</If>
				{props.children}
			</View>
			<View class="flex-row flex-wrap items-center gap-2.5">{props.actions}</View>
		</View>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Older shapes, kept while screens move.

/** One quiet closing line under the page's panel ("That is everything for now."). */
export function PageFoot(props: { text: string; testID?: string }) {
	return (
		<Text testID={props.testID} class="px-1 pt-4 text-faint" style={TYPE.caption}>
			{props.text}
		</Text>
	);
}

/** Takes the free space in a row, pushing what follows to its end: key hints at the end of a Question's foot. */
export function Spacer() {
	return <View class="flex-1" />;
}

/**
 * The column every page sat in.
 * @deprecated Use `Page`.
 */
export const PAGE_COLUMN = "w-full max-w-5xl self-center px-6 pb-24 pt-10";

/**
 * A page's one title.
 * @deprecated Use `PageHead` (its `title` is the Display role).
 */
export function PageTitle(props: { title: string; testID?: string; class?: string }) {
	return (
		<Text testID={props.testID} role="header" class={`text-foreground ${props.class ?? ""}`} style={TYPE.display}>
			{props.title}
		</Text>
	);
}

/**
 * A section's title with an optional count and trailing content.
 * @deprecated Use `Section`: its head holds the heading, the count pill, a note and one action.
 */
export function SectionTitle(props: { title: string; count?: number | null; children?: JSX.Element }) {
	return (
		<View class="flex-row items-center gap-2">
			<Text role="header" class="text-foreground" style={TYPE.heading}>
				{props.title}
			</Text>
			<If when={props.count != null && props.count > 0}>
				<Pill count={props.count ?? 0} />
			</If>
			<View class="flex-1" />
			{props.children}
		</View>
	);
}

const QUIET_PANEL: Record<"sm" | "md" | "lg", string> = {
	sm: "rounded-lg px-3 py-2",
	md: "rounded-lg px-3.5 py-3",
	lg: "rounded-lg p-4",
};

/**
 * A muted block that sets one thing apart: a quote, a confirmation, a report. Formerly `Panel`.
 * @deprecated A problem is a `Notice`, a thing that waits for an answer is a `Question`, a list is a `Section` of
 * `Row`s, and a quote or code is a `Quote`. Sections never get their own box.
 */
export function QuietPanel(props: {
	testID?: string;
	size?: "sm" | "md" | "lg";
	tone?: "muted" | "card";
	selectable?: boolean;
	class?: string;
	anchor?: (node: ViewRef) => void;
	children?: JSX.Element;
}) {
	return (
		<View
			ref={props.anchor}
			testID={props.testID}
			selectable={props.selectable}
			class={`${QUIET_PANEL[props.size ?? "md"]} ${props.tone === "card" ? "border border-border bg-card" : "bg-muted"} ${props.class ?? ""}`}
		>
			{props.children}
		</View>
	);
}
