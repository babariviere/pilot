// The page's frame: its column, its title, section titles and the quiet
// panel that groups one thing. Pages put their content inside these.
import { type JSX, Text, View } from "nsh";

/**
 * The column every page sits in: centred, up to 1024 px wide, with the page's side and top padding. Change the
 * width here for all pages. Long paragraphs inside may keep a narrower measure for comfortable reading.
 */
export const PAGE_COLUMN = "w-full max-w-5xl self-center px-6 pb-24 pt-10";

const PAGE_GAP = { 4: "gap-4", 8: "gap-8", 10: "gap-10", 12: "gap-12" } as const;

/** A page's column, inside the screen's `Scroll`: its sections, spaced by `gap` (Tailwind's scale, default 8). */
export function Page(props: { testID?: string; gap?: keyof typeof PAGE_GAP; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class={`${PAGE_COLUMN} ${PAGE_GAP[props.gap ?? 8]}`}>
			{props.children}
		</View>
	);
}

/** A page's one title, the first heading screen readers find. */
export function PageTitle(props: {
	title: string;
	testID?: string;
	/** Layout classes only, such as `flex-1`. */
	class?: string;
}) {
	return (
		<Text
			testID={props.testID}
			role="header"
			class={`text-3xl font-semibold leading-tight tracking-tight text-foreground ${props.class ?? ""}`}
		>
			{props.title}
		</Text>
	);
}

/** A section's title with an optional count and trailing content. */
export function SectionTitle(props: { title: string; count?: number | null; children?: JSX.Element }) {
	return (
		<View class="flex-row items-baseline gap-2">
			<Text role="header" class="text-sm font-semibold text-muted-foreground">
				{props.title}
			</Text>
			<If when={props.count != null && props.count > 0}>
				<Text class="text-sm text-faint">{String(props.count)}</Text>
			</If>
			<View class="flex-1" />
			{props.children}
		</View>
	);
}

const PANEL: Record<"sm" | "md" | "lg", string> = {
	sm: "rounded-lg px-3 py-2",
	md: "rounded-xl px-4 py-3",
	lg: "rounded-xl p-4",
};

/**
 * The panel's surface. `muted` (the default) sets a quote or confirmation apart; `card` frames one piece of
 * work that stands on its own, such as a task working now, with a border on the page's card colour.
 */
const PANEL_TONE: Record<"muted" | "card", string> = {
	muted: "bg-muted",
	card: "border border-border bg-card",
};

/**
 * A quiet muted panel that sets one thing apart: a confirmation, a quote, a report. `sm` frames a short quote,
 * `md` (the default) a block, `lg` a block with more room. `tone="card"` frames one piece of work instead.
 */
export function Panel(props: {
	testID?: string;
	size?: "sm" | "md" | "lg";
	tone?: "muted" | "card";
	/** Lets the user select and copy what it holds. */
	selectable?: boolean;
	/** Layout classes only, such as `gap-2` or `flex-row items-center`. */
	class?: string;
	children?: JSX.Element;
}) {
	return (
		<View
			testID={props.testID}
			selectable={props.selectable}
			class={`${PANEL[props.size ?? "md"]} ${PANEL_TONE[props.tone ?? "muted"]} ${props.class ?? ""}`}
		>
			{props.children}
		</View>
	);
}
