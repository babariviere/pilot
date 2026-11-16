import { signal, Text, View } from "nsh";
import { ArtifactExport as NativeExport } from "pilot-day/native";
import type { SavedArtifact } from "./artifactReads";
import { Action } from "./ui";

/** Local export of the saved copy on screen, never a read of a newer revision. */
export function ArtifactExport(props: { artifact: SavedArtifact }) {
	const busy = signal(false);
	const message = signal("");
	const exporter = new NativeExport();
	const save = async () => {
		if (busy()) return;
		busy.set(true);
		try {
			message.set(await exporter.save(JSON.stringify(props.artifact)));
		} catch {
			message.set("Export did not finish. Check the destination before trying again.");
		} finally {
			busy.set(false);
		}
	};
	return (
		<View class="gap-1">
			<Action
				label={
					busy() ? "Exporting…" : props.artifact.metadata.kind === "image" ? "Export image…" : "Export source…"
				}
				testID="artifact-export"
				disabled={busy() || props.artifact.content.state === "unavailable"}
				onPress={() => void save()}
			/>
			<If when={message()}>
				<Text role="alert" class="text-xs text-muted-foreground">
					{message()}
				</Text>
			</If>
		</View>
	);
}
