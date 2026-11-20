// State: one mark and one word per state, the same on every screen. Marks are built from squares (the Forge
// skin): a filled square needs you, a broken square failed, a checked square is ready to merge, a hollow square
// works, two bars pause, a small square is new and a tick is done. Colour is only amber, red and green; the
// word and the accessible name always carry the state, so colour is never the only signal.
// Progress is a row of squares and a count; a Pill is a count.
import { Image, type JSX, Text, View } from "nsh";
import markCheck from "../icons/mark-check.svg";
import markReady from "../icons/mark-ready.svg";
import { Icon } from "./icon";
import { TONE, type Tone, TYPE } from "./text";

/** The seven states. Every screen uses these words: Needs you, Failed, Ready to merge, Working, Paused, New, Done. */
export type StateKind = "needs" | "failed" | "ready" | "working" | "paused" | "new" | "done";

/**
 * A mark's kind: one of the seven states, or an older kind kept while screens move.
 * @deprecated kinds `unknown` (a needs-you that is not confirmed: hollow amber square), `moving` (use
 * `working`), `still` (a quiet, waiting item: small faint square), `unreported` (no current report: thin hollow
 * square) and `oldReport` (a document icon). New code uses the seven states.
 */
export type MarkKind = StateKind | "unknown" | "moving" | "still" | "unreported" | "oldReport";

/** Each state's one word. */
export const STATE_WORDS: Record<StateKind, string> = {
	needs: "Needs you",
	failed: "Failed",
	ready: "Ready to merge",
	working: "Working",
	paused: "Paused",
	new: "New",
	done: "Done",
};

/** The word tone of a mark's kind: amber, red and green only for those three states. */
export function markTone(kind: MarkKind): Tone {
	if (kind === "needs" || kind === "unknown") return "needs";
	if (kind === "failed") return "failed";
	if (kind === "ready") return "ok";
	return "muted";
}

type Square = { x: number; y: number; w: number; h?: number; fill: string; hollow?: number };

const HOLLOW = { x: 3.5, y: 3.5, w: 7 };

/** Each kind as squares on a 14-point grid (round-4's marks). Ready and Done add a tick. */
const SQUARES: Record<MarkKind, Square[]> = {
	needs: [{ x: 3, y: 3, w: 8, fill: "bg-needs" }],
	failed: [
		{ x: 2.5, y: 2.5, w: 3, fill: "bg-failed" },
		{ x: 8.5, y: 2.5, w: 3, fill: "bg-failed" },
		{ x: 5.5, y: 5.5, w: 3, fill: "bg-failed" },
		{ x: 2.5, y: 8.5, w: 3, fill: "bg-failed" },
		{ x: 8.5, y: 8.5, w: 3, fill: "bg-failed" },
	],
	ready: [{ x: 2, y: 2, w: 10, fill: "bg-ok" }],
	working: [{ ...HOLLOW, fill: "border-muted-foreground", hollow: 1.75 }],
	moving: [{ ...HOLLOW, fill: "border-muted-foreground", hollow: 1.75 }],
	unknown: [{ ...HOLLOW, fill: "border-needs", hollow: 1.75 }],
	unreported: [{ ...HOLLOW, fill: "border-faint", hollow: 1 }],
	paused: [
		{ x: 4, y: 3.5, w: 2, h: 7, fill: "bg-muted-foreground" },
		{ x: 8, y: 3.5, w: 2, h: 7, fill: "bg-muted-foreground" },
	],
	new: [{ x: 5, y: 5, w: 4, fill: "bg-faint" }],
	still: [{ x: 5.5, y: 5.5, w: 3, fill: "bg-faint" }],
	done: [],
	oldReport: [],
};

/**
 * A still, 14-point state mark built from squares. The words beside it carry the meaning; `label` names it for
 * screen readers when no words stand beside it. Marks never loop: a change of kind swaps the mark in place.
 */
export function Mark(props: { kind: MarkKind; label?: string }) {
	return (
		<View
			class="relative size-3.5 shrink-0"
			accessible={!!props.label}
			accessibilityLabel={props.label}
			role={props.label ? "image" : undefined}
		>
			<Each of={SQUARES[props.kind] ?? []} key={(s) => `${s.x}:${s.y}`}>
				{(s) => (
					<View
						class={`absolute ${s().fill}`}
						style={{
							left: s().x,
							top: s().y,
							width: s().w,
							height: s().h ?? s().w,
							borderWidth: s().hollow ?? 0,
						}}
					/>
				)}
			</Each>
			<If when={props.kind === "ready"}>
				<Image src={markReady} accessible={false} fadeDuration={0} class="absolute inset-0 size-3.5 tint-card" />
			</If>
			<If when={props.kind === "done"}>
				<Image src={markCheck} accessible={false} fadeDuration={0} class="absolute inset-0 size-3.5 tint-faint" />
			</If>
			<If when={props.kind === "oldReport"}>
				<View class="absolute -inset-px">
					<Icon name="document" tint="tint-faint" />
				</View>
			</If>
		</View>
	);
}

/** The soft fill of a state pill, by its word's tone. */
export const STATE_FILL: Record<Tone, string> = {
	default: "bg-muted",
	muted: "bg-muted",
	faint: "bg-muted",
	needs: "bg-needs-soft",
	failed: "bg-failed-soft",
	ok: "bg-ok-soft",
	accent: "bg-muted",
	onAccent: "bg-muted",
};

/**
 * A state as its mark and word in a soft pill: "Needs you", "Failed", "Ready to merge", or the screen's more exact
 * word for the same state ("Did not confirm", "Pausing"). `plain` drops the pill, for a meta line.
 */
export function State(props: { kind: MarkKind; label?: string; plain?: boolean; testID?: string }) {
	const word = () => props.label ?? (STATE_WORDS as Record<string, string>)[props.kind] ?? "";
	const tone = () => markTone(props.kind);
	return (
		<View
			testID={props.testID}
			class={`flex-row items-center gap-1.5 self-start ${props.plain ? "" : `rounded-full py-0.5 pl-1.5 pr-2.5 ${STATE_FILL[tone()]}`}`}
		>
			<Mark kind={props.kind} />
			<Text class={TONE[tone()]} style={TYPE.caption}>
				{word()}
			</Text>
		</View>
	);
}

/** The counts a Progress draws: the same shape as a mission's task counts. */
export type ProgressCounts = { done: number; review: number; active: number; blocked: number; todo: number };

/**
 * How many squares a Progress draws at most. Past it, each square stands for a share of the tasks, so a long
 * mission keeps a row that fits a row's trailing slot (12 squares and "40/48" take about 110 points).
 */
const MOST_SQUARES = 12;

/** Which squares are done, stopped and left, for `counts`. */
export function progressSquares(counts: ProgressCounts): ("done" | "blocked" | "left")[] {
	const total = counts.done + counts.review + counts.active + counts.blocked + counts.todo;
	if (total === 0) return [];
	const n = Math.min(total, MOST_SQUARES);
	const done = total <= MOST_SQUARES ? counts.done : Math.floor((counts.done / total) * n);
	const blocked = Math.min(n - done, total <= MOST_SQUARES ? counts.blocked : Math.ceil((counts.blocked / total) * n));
	return Array.from({ length: n }, (_, i) => (i < done ? "done" : i < done + blocked ? "blocked" : "left"));
}

/**
 * Progress as a row of squares and a count ("■■■■□□□ 4/7"): done squares dark, stopped ones red, the rest faint.
 * Screen readers hear "4 of 7 done".
 */
export function Progress(props: { counts: ProgressCounts; testID?: string }) {
	const total = () =>
		props.counts.done + props.counts.review + props.counts.active + props.counts.blocked + props.counts.todo;
	const squares = () => progressSquares(props.counts).map((kind, i) => ({ kind, i }));
	return (
		<View
			testID={props.testID}
			class="flex-row items-center gap-1.5"
			accessible
			accessibilityLabel={`${props.counts.done} of ${total()} done`}
		>
			<View class="flex-row items-center" style={{ gap: 1.5 }}>
				<Each of={squares()} key={(s) => s.i}>
					{(s) => (
						<View
							class={
								s().kind === "done"
									? "bg-muted-foreground"
									: s().kind === "blocked"
										? "bg-failed"
										: "bg-border-strong"
							}
							style={{ width: 5, height: 5 }}
						/>
					)}
				</Each>
			</View>
			<Text class="font-mono text-faint" style={TYPE.number}>{`${props.counts.done}/${total()}`}</Text>
		</View>
	);
}

/** A count in a small mono pill, beside a section heading, a tab or a button. `needs` tints it amber. */
export function Pill(props: { count: number | string; tone?: "quiet" | "needs"; testID?: string }) {
	return (
		<View
			testID={props.testID}
			class={`items-center justify-center rounded-full px-1.5 ${props.tone === "needs" ? "bg-needs-soft" : "bg-muted"}`}
			style={{ minWidth: 18, height: 16 }}
		>
			<Text
				class={`font-mono ${props.tone === "needs" ? "text-needs-ink" : "text-muted-foreground"}`}
				style={TYPE.number}
			>
				{String(props.count)}
			</Text>
		</View>
	);
}

/**
 * A mark beside content that may wrap: the mark sits on the first line.
 * @deprecated Use `Row` for a list item or `Notice` for one problem. Kept while screens move.
 */
export function MarkLine(props: { kind: MarkKind; testID?: string; selectable?: boolean; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="flex-row items-start gap-2.5">
			<View class="py-0.5">
				<Mark kind={props.kind} />
			</View>
			<View selectable={props.selectable} class="min-w-0 flex-1 gap-0.5">
				{props.children}
			</View>
		</View>
	);
}
