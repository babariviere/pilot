// A read-only diff of one exact patch.
import { Text } from "nsh";
import { Button, type DiffFile, DiffView, type DiffViewClasses, type DiffViewRef } from "nsh/base";
import { FOCUS_RING } from "./button";

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
