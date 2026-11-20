// Saved NSH source is data here. Only the app-owned native component runs it,
// in another engine with local state and no connected host services. Out of
// view, the preview pauses: NSH has no way to freeze a running engine, so it
// stops and starts again from the same saved revision when it shows. Its
// local state starts over then.
import { effect, nativeComponent, signal, View, type ViewRef } from "nsh";
import type { SavedArtifact, Shown } from "./artifactReads";
import { rested, showsInPage } from "./onScreen";
import { SourcePanel } from "./SourcePanel";
import { Body, Button, Caption, Notice } from "./ui";

type State = { state: string; message: string };
const NativePreview = nativeComponent<{ snapshot: SavedArtifact }, { state: State }>("pilot/artifact-preview", {
	props: ["snapshot"],
	events: ["state"],
});

/** `fill`: takes the height it is given, as in the full window, and never pauses out of the page's view. */
export function ArtifactPreview(props: { inspection: Shown; fill?: boolean }) {
	const state = signal<State>({ state: "loading", message: "" });
	const inView = signal(true);
	// Each start of the preview's engine. Start again makes a new one from the same saved revision.
	const run = signal(0);
	const startAgain = () => {
		state.set({ state: "loading", message: "" });
		run.update((n) => n + 1);
	};
	let box: ViewRef | undefined;
	let checks = 0;
	const check = () => {
		const node = box;
		if (!node || props.fill) return;
		const mine = ++checks;
		void showsInPage(node).then((shows) => {
			if (mine !== checks || shows === inView()) return;
			if (shows) state.set({ state: "loading", message: "" });
			inView.set(shows);
		});
	};
	// Once when it lays out, then each time the page's scrolling rests.
	effect(() => {
		rested();
		check();
	});
	const saved = () => props.inspection.artifact;
	const present = () => saved()?.content.state === "text";
	// The preview's chrome uses the parts; the preview itself is the agent's document and keeps its own look.
	return (
		<View testID="artifact-preview" class={`gap-2 ${props.fill ? "flex-1" : ""}`}>
			<If when={props.inspection.state === "reading" || (present() && inView() && state().state === "loading")}>
				<Body tone="muted">Opening the saved preview…</Body>
			</If>
			<If when={props.inspection.state === "refused"}>
				<Body role="alert" tone="muted">
					{props.inspection.message}
				</Body>
			</If>
			<If when={saved()?.content.state === "unavailable"}>
				<Body tone="muted">This saved revision is not available to preview.</Body>
			</If>
			<If when={state().state === "error" || state().state === "stopped"}>
				{/* One problem and its way out: the preview failed or was stopped; the saved source stays readable. */}
				<Notice
					testID={state().state === "stopped" ? "artifact-preview-stopped" : "artifact-preview-error"}
					role="alert"
					kind={state().state === "stopped" ? "needs" : "failed"}
					text={
						state().state === "stopped"
							? `This preview was stopped: ${state().message}. Pilot limits each preview's memory and time. Retry preview resets it.`
							: state().message
					}
					detail="The saved source is still readable below. Retry starts a fresh preview."
					action={<Button small label="Retry preview" testID="artifact-preview-retry" onPress={startAgain} />}
				/>
				<SourcePanel inspection={props.inspection} />
			</If>
			<If when={present()}>
				<View
					ref={(node: ViewRef) => {
						box = node;
						check();
					}}
					class={props.fill ? "min-h-0 w-full flex-1" : "h-96 w-full"}
				>
					<If
						when={inView()}
						else={
							<View testID="artifact-preview-paused" class="flex-1 items-center justify-center">
								<Body tone="muted">
									Paused out of view. It starts again from this saved revision when it shows.
								</Body>
							</View>
						}
					>
						<Each of={[run()]} key={(n) => String(n)}>
							{() => (
								<NativePreview
									snapshot={saved() as SavedArtifact}
									class="h-full w-full"
									onState={(next) => state.set(next)}
								/>
							)}
						</Each>
					</If>
				</View>
			</If>
			<Caption tone="faint">Changes stay in this preview. Opening it does not mark the work done.</Caption>
			<If when={present() && state().state !== "error" && state().state !== "stopped"}>
				<View class="flex-row">
					<Button small label="Reset" testID="artifact-preview-reset" onPress={startAgain} />
				</View>
			</If>
		</View>
	);
}
