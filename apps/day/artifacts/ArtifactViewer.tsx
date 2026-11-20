// What every artifact viewer shares: the line naming what its one pane shows,
// the pane itself, the header's Share and full-window icons, and the full
// window over the page. A viewer keeps its own reads, pins and Before/After
// side; the full window shows a copy of the pane it was opened from and
// reads nothing. When that pane stops being what its page shows (a newer
// result, another pin or side, a closed page), the copy closes at once.
import { cleanup, effect, keymap, Scroll, signal, View, type ViewRef } from "nsh";
import { kindName } from "../missions/delivery/deliveryView";
import { artifactPreviewsAvailable } from "../sources/bridge";
import { Body, Button, Caption, FullWindow, glide, Heading } from "../ui";
import { ShareMenu, savedTitle } from "./ArtifactExport";
import { ArtifactPreview } from "./ArtifactPreview";
import type { Shown } from "./artifactReads";
import { SourcePanel } from "./SourcePanel";

/** Whether `shown` runs in the app's isolated preview rather than showing its saved content. */
export function showsPreview(shown: Shown): boolean {
	return !!shown.preview && shown.kind === "nsh";
}

/** "Source · HTML · revision 3": what the pane shows, of which kind and saved revision. */
export function paneLine(shown: Shown): string {
	const revision = `revision ${shown.pin.revision}`;
	if (shown.kind === "image") return `Image · ${revision}`;
	return `${showsPreview(shown) ? "Preview" : "Source"} · ${kindName(shown.kind)} · ${revision}`;
}

/** The pane's content: the isolated preview, a saved image, or saved text that scrolls when it has a height. */
function Pane(props: { shown: Shown; fill?: boolean }) {
	const image = () => props.shown.artifact?.content.state === "image";
	return (
		<If
			when={showsPreview(props.shown)}
			else={
				<If when={props.fill && !image()} else={<SourcePanel inspection={props.shown} fill={props.fill} />}>
					<Scroll class="min-h-0 flex-1">
						<SourcePanel inspection={props.shown} />
					</Scroll>
				</If>
			}
		>
			<ArtifactPreview inspection={props.shown} fill={props.fill} />
		</If>
	);
}

/**
 * One pane. `bounded` holds it, preview or saved content alike, at one fixed
 * height that scrolls, so switching Before and After never moves the page.
 * `fill` takes the room it is given, as in the full window, where an image
 * grows to fit it.
 */
export function ArtifactBody(props: { shown: Shown; bounded?: boolean; fill?: boolean }) {
	return (
		<If when={props.bounded} else={<Pane shown={props.shown} fill={props.fill} />}>
			<Scroll testID="artifact-pane" class="h-[30rem]">
				<Pane shown={props.shown} />
			</Scroll>
		</If>
	);
}

/**
 * The header's icons for the pane shown: Share, then full window (`onFull`,
 * told how to give the focus back) or its exit (`onExit`). Each appears only
 * when it applies.
 */
export function ArtifactTools(props: {
	shown: Shown;
	testID: string;
	onFull?: (back: () => void) => void;
	onExit?: () => void;
	/** Hears the exit icon, to give it the keyboard focus. */
	exitAnchor?: (node: ViewRef) => void;
}) {
	let fullButton: ViewRef | undefined;
	return (
		<View class="flex-row flex-wrap items-center justify-end gap-1">
			<ShareMenu shown={props.shown} testID={`${props.testID}-share`} />
			<If
				when={
					props.onFull && props.shown.state === "shown" && props.shown.artifact?.content.state !== "unavailable"
				}
			>
				<Button
					small
					label="Show in the full window"
					icon="fullscreen"
					iconOnly
					testID={`${props.testID}-full`}
					anchor={(node) => {
						fullButton = node;
					}}
					onPress={() => props.onFull?.(() => fullButton?.focus())}
				/>
			</If>
			<If when={props.onExit}>
				<Button
					small
					label="Close full window (Esc)"
					icon="fullscreenExit"
					iconOnly
					testID={`${props.testID}-close`}
					anchor={props.exitAnchor}
					onPress={() => props.onExit?.()}
				/>
			</If>
		</View>
	);
}

/**
 * The pane in the full window. `id` names the viewer it came from, which hides
 * its own pane meanwhile, so one preview runs. `live` says whether the copy is
 * still what that viewer shows; `back` gives the focus back on close.
 * `side` names a comparison's Before or After.
 */
type Full = { shown: Shown; id: unknown; side?: string; live: () => boolean; back: () => void };

const fullView = signal<Full | null>(null);

/** Shows `full.shown` in the full window. Only a pane already read shows there. */
export function openFull(full: Full) {
	if (full.shown.state !== "shown" || !full.live()) return;
	glide();
	fullView.set(full);
}

/** Whether the viewer `id` has its pane in the full window. */
export function inFull(id: unknown): boolean {
	return fullView()?.id === id;
}

/** Closes the full window from its viewer `id`, as that viewer goes. Nothing gets the focus. */
export function closeFullFor(id: unknown) {
	if (fullView()?.id === id) fullView.set(null);
}

/** The user closes the full window: the focus goes back to where it was opened. */
function closeFull() {
	const now = fullView();
	if (!now) return;
	glide();
	fullView.set(null);
	now.back();
}

/** Where a viewer without its pane in view says so, in the pane's place. */
export function InFullNote() {
	return <Body tone="muted">Showing in the full window. Esc comes back here.</Body>;
}

/**
 * The open pane in the whole window, over the page, which stays as it was
 * underneath. It is a dialog: the keyboard stays in it, starting on its exit
 * icon, and nothing underneath takes presses or keys. Escape (once an open
 * menu in it has closed) or the exit icon comes back to its viewer, on the
 * same side and pin. The window has one; it shows only while a pane is opened there.
 */
export function FullArtifact() {
	let exit: ViewRef | undefined;
	effect(() => {
		const now = fullView();
		if (now && !now.live()) fullView.set(null);
	});
	// Newer than any page's Escape, so it closes this first; a menu open in it closes before.
	effect(() => {
		if (!fullView()) return;
		cleanup(keymap.bind("escape", closeFull, { when: "always" }));
	});
	const toggle = () => {
		const now = fullView();
		if (!now) return;
		glide();
		fullView.set({ ...now, shown: { ...now.shown, preview: !now.shown.preview } });
	};
	return (
		<If when={fullView()}>
			{(v) => (
				<FullWindow
					testID="artifact-full"
					padded
					// Escape is the keymap's, so a menu open in the window closes first.
					dialog={{
						label: `${savedTitle(v().shown)}, in the full window`,
						testID: "artifact-full-dialog",
						onOpen: () => exit?.focus(),
					}}
					bar={
						<>
							<Heading role="header" truncate>
								{`${savedTitle(v().shown)} · ${kindName(v().shown.kind)} · revision ${v().shown.pin.revision}`}
							</Heading>
							<Caption tone="faint">
								{v().side ? `${v().side} · ${paneLine(v().shown)}` : paneLine(v().shown)}
							</Caption>
						</>
					}
					actions={
						<>
							<If when={v().shown.kind === "nsh" && artifactPreviewsAvailable()}>
								<Button
									small
									label={v().shown.preview ? "Inspect source" : "Show preview"}
									testID="artifact-full-toggle"
									onPress={toggle}
								/>
							</If>
							<ArtifactTools
								shown={v().shown}
								testID="artifact-full"
								onExit={closeFull}
								exitAnchor={(node) => {
									exit = node;
								}}
							/>
						</>
					}
				>
					<ArtifactBody shown={v().shown} fill />
				</FullWindow>
			)}
		</If>
	);
}
