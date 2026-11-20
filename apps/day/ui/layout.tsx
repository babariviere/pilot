// The page's frame: its centred column and its head. A page is a PageHead, then one Panel with its tabs.
import { type JSX, Text, View, windowSize } from "nsh";
import { Display, TYPE } from "./text";

/** Below this window width a page uses narrow side padding, stacks its head and stacks a panel's columns. */
export const NARROW = 880;

/** Whether the window is narrow (see `NARROW`). Reactive. */
export function narrow(): boolean {
	return windowSize().width < NARROW;
}

/** The page widths: one panel at most 1088 points wide (1040 inside the padding), 840 for a form such as Settings. */
const WIDTH = { page: 1088, form: 840 } as const;

/**
 * The width inside a page's panel at the current window size (reactive): the page's width less its side padding
 * and the panel's two hairlines. For a drawing that sizes itself to the panel (the plan's chart), so it neither
 * clips nor leaves a gap at either side.
 */
export function panelWidth(width: keyof typeof WIDTH = "page"): number {
	const page = Math.min(windowSize().width, WIDTH[width]);
	return page - (narrow() ? 24 : 48) - 2;
}

/**
 * A page's centred column, inside the screen's `Scroll`: at most 1088 points wide (`width="form"`: 840), 24 points
 * at the sides (12 in a narrow window), 30 above. It holds a `PageHead`, then one `Panel`. `fill` is for a page whose
 * content scrolls on its own (a diff): it fills the window's height instead of sitting in a `Scroll`, and its
 * `Panel fill` takes the rest. Rule: one panel per page; the page sets no colours and no look of its own.
 */
export function Page(props: {
	testID?: string;
	/** `page` (default) or `form` for a settings-like page. */
	width?: keyof typeof WIDTH;
	/** Fills the window's height (not in a Scroll), for a `Panel fill`. */
	fill?: boolean;
	children?: JSX.Element;
}) {
	return (
		<View
			testID={props.testID}
			class={`w-full self-center pt-7.5 ${narrow() ? "px-3" : "px-6"} ${props.fill ? "min-h-0 flex-1 pb-6" : "pb-24"}`}
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
	/** The test ID of the sentences under the title (`text`). */
	textTestID?: string;
	testID?: string;
	/** A quiet line above the title, such as the date (use `Num` or `Caption`). */
	pre?: JSX.Element;
	/** The page's state beside the title (a `State`). */
	state?: JSX.Element;
	/** One or two sentences under the title. */
	text?: string;
	/** Anything else under the text: a quiet note, a notice about the whole page. */
	children?: JSX.Element;
	/** Buttons at the right: Secondary `Button`s, a `Picker`. */
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
					<Text testID={props.textTestID} class="max-w-xl text-muted-foreground" style={TYPE.body}>
						{props.text ?? ""}
					</Text>
				</If>
				{props.children}
			</View>
			<View class="flex-row flex-wrap items-center gap-2.5">{props.actions}</View>
		</View>
	);
}

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
