// Saved NSH source is data here. Only the app-owned native component runs it,
// in another engine with local state and no connected host services.
import { nativeComponent, signal, Text, View } from "nsh";
import type { CapturedArtifact } from "./deliveryArtifactContract";
import type { Inspection } from "./deliveryView";

type State = { state: string; message: string };
const NativePreview = nativeComponent<{ snapshot: CapturedArtifact }, { state: State }>("pilot/artifact-preview", {
	props: ["snapshot"],
	events: ["state"],
});

export function ArtifactPreview(props: { inspection: Inspection }) {
	const state = signal<State>({ state: "loading", message: "" });
	const saved = () => props.inspection.artifact;
	const present = () => saved()?.content.state === "text";
	return (
		<View testID="artifact-preview" class="gap-2 rounded-xl bg-muted px-4 py-3">
			<Text class="text-xs text-faint">{`Preview · revision ${props.inspection.pin.revision}`}</Text>
			<Text role="header" class="text-sm font-medium text-foreground">
				{props.inspection.title || "Artifact"}
			</Text>
			<If when={props.inspection.state === "reading" || (present() && state().state === "loading")}>
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
			<If when={present()}>
				<NativePreview
					snapshot={saved() as CapturedArtifact}
					class="h-96 w-full"
					onState={(next) => state.set(next)}
				/>
			</If>
			<Text class="text-xs text-faint">Changes stay in this preview. Opening it does not mark the work done.</Text>
		</View>
	);
}
