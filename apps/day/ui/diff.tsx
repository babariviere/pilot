// A read-only diff of one exact patch.
import { type JSX, signal, Text, View } from "nsh";
import type { DiffAnnotation, DiffLineRange } from "nsh/base";
import { Button, type DiffFile, DiffView, type DiffViewClasses, type DiffViewRef } from "nsh/base";
import { FOCUS_RING } from "./button";
import { Icon } from "./icon";

export type { DiffAnnotation, DiffLineRange } from "nsh/base";

/**
 * Saved two-text comparison with private annotations. Callers own selections and comment bodies. The Comment
 * control shows only on the selected lines' last row, as a small + in the change-mark column, so it never covers
 * line numbers or code. NSH places it in the gutter, so a wider label would cover the numbers.
 */
export function ReviewDiff(props: {
	before: string;
	after: string;
	language: string;
	annotations: DiffAnnotation[];
	/** Hears the view, to clear its line selection. */
	ref?: (diff: DiffViewRef) => void;
	onSelection: (range: DiffLineRange | null) => void;
	onComment: (range: DiffLineRange) => void;
	renderAnnotation: (annotation: DiffAnnotation) => JSX.Element;
}) {
	const selected = signal<DiffLineRange | null>(null);
	const isSelected = (range: DiffLineRange) => {
		const s = selected();
		return !!s && s.side === range.side && s.start === range.start && s.end === range.end;
	};
	return (
		<DiffView
			ref={(diff) => props.ref?.(diff)}
			testID="review-diff"
			oldValue={props.before}
			newValue={props.after}
			language={props.language}
			layout="unified"
			indicators="classic"
			inline="word"
			softWrap
			classes={DIFF_CLASSES}
			class="flex-1 min-h-0"
			onLineSelectionChange={({ range }) => {
				selected.set(range);
				props.onSelection(range);
			}}
			annotations={props.annotations}
			renderAddAnnotation={(range) => (
				<If when={isSelected(range)}>
					<View class="absolute inset-y-0 right-0 justify-center pr-0.5">
						<Button
							accessibilityLabel="Comment on these code lines"
							tooltip="Comment on these lines"
							onPress={() => props.onComment(range)}
							class={`size-4 items-center justify-center rounded bg-primary ${FOCUS_RING}`}
						>
							<Icon name="plus" tint="tint-primary-foreground" />
						</Button>
					</View>
				</If>
			)}
			renderAnnotation={(annotation) => props.renderAnnotation(annotation)}
		/>
	);
}

/**
 * The diff's parts. `lineSelected` is drawn over the selected rows' code,
 * so it must stay see-through: the theme's `selection` is an opaque fill
 * (made for chips and options) and would hide the code under it.
 */
export const DIFF_CLASSES: DiffViewClasses = {
	gutter: "bg-background",
	lineNumber: "text-faint",
	content: "text-foreground",
	lineAdded: "bg-added",
	lineDeleted: "bg-removed",
	wordAdded: "bg-added-strong",
	wordDeleted: "bg-removed-strong",
	indicatorAdded: "text-ok-ink",
	indicatorDeleted: "text-failed-ink",
	separator: "bg-muted text-faint",
	filler: "bg-muted",
	lineSelected: "bg-primary/15",
};

/** A file's header in the diff: its path and counts. A press folds its lines away or back. */
function FileHeader(props: { file: DiffFile; onToggle: () => void }) {
	const path = () => (props.file.oldPath ? `${props.file.oldPath} → ${props.file.path}` : props.file.path);
	return (
		<Button
			accessibilityLabel={`${path()}. ${props.file.collapsed ? "Show its lines" : "Hide its lines"}.`}
			onPress={props.onToggle}
			class={`flex-1 flex-row items-center gap-2 border-y border-border bg-muted px-3 hover:bg-accent ${FOCUS_RING}`}
		>
			<Text class="w-3 text-xs text-faint">{props.file.collapsed ? "▸" : "▾"}</Text>
			<Text class="flex-1 truncate font-mono text-xs text-foreground">{path()}</Text>
			<Text class="text-xs text-faint">
				{props.file.binary ? "binary" : `+${props.file.added} −${props.file.deleted}`}
			</Text>
		</Button>
	);
}

/**
 * A read-only diff of one exact patch: one column, changed words marked,
 * long lines wrapped, each file under its header. Only the rows in view are
 * made, so a long patch stays light. It fills the room its page gives it,
 * with no frame of its own: the page is the review. It offers no hunk
 * actions: nothing here edits, reverts or keeps a change.
 */
export function PatchDiff(props: { patch: string; testID?: string }) {
	let diff: DiffViewRef | undefined;
	return (
		<DiffView
			ref={(r) => {
				diff = r;
			}}
			testID={props.testID}
			patch={props.patch}
			layout="unified"
			inline="word"
			indicators="classic"
			softWrap
			class="min-h-0 flex-1"
			classes={DIFF_CLASSES}
			renderFileHeader={(file) => <FileHeader file={file} onToggle={() => diff?.toggleFile(file.path)} />}
		/>
	);
}
