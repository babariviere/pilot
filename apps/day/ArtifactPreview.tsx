// Saved NSH source is data here. Only the app-owned native component runs it,
// in another engine with local state and no connected host services. Out of
// view, the preview pauses: NSH has no way to freeze a running engine, so it
// stops and starts again from the same saved revision when it shows. Its
// local state starts over then.
import { effect, nativeComponent, signal, Text, View, type ViewRef } from "nsh";
import type { SavedArtifact, Shown } from "./artifactReads";
import { rested, showsInPage } from "./onScreen";
import { Action } from "./ui";

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
	return (
		<View testID="artifact-preview" class={`gap-2 rounded-xl bg-muted px-4 py-3 ${props.fill ? "flex-1" : ""}`}>
			<Text class="text-xs text-faint">{`Preview · revision ${props.inspection.pin.revision}`}</Text>
			<Text role="header" class="text-sm font-medium text-foreground">
				{props.inspection.title || "Artifact"}
			</Text>
			<If when={props.inspection.state === "reading" || (present() && inView() && state().state === "loading")}>
				<Text class="text-sm text-muted-foreground">Opening the saved preview…</Text>
			</If>
			<If when={props.inspection.state === "refused"}>
				<Text role="alert" class="text-sm text-muted-foreground">
					{props.inspection.message}
				</Text>
			</If>
			<If when={saved()?.content.state === "unavailable"}>
				<Text class="text-sm text-muted-foreground">This saved revision is not available to preview.</Text>
			</If>
			<If when={state().state === "error"}>
				<Text role="alert" testID="artifact-preview-error" class="text-sm text-muted-foreground">
					{state().message}
				</Text>
			</If>
			<If when={state().state === "stopped"}>
				<View class="flex-row items-start gap-4">
					<Text role="alert" testID="artifact-preview-stopped" class="flex-1 text-sm text-needs-ink">
						{`This preview was stopped: ${state().message}. Pilot limits each preview so a runaway mock cannot use up Day's memory or time. Start again resets it.`}
					</Text>
					<Action label="Start again" icon="refresh" testID="artifact-preview-restart" onPress={startAgain} />
				</View>
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
								<Text class="text-sm text-muted-foreground">
									Paused out of view. It starts again from this saved revision when it shows.
								</Text>
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
			<Text class="text-xs text-faint">Changes stay in this preview. Opening it does not mark the work done.</Text>
		</View>
	);
}
