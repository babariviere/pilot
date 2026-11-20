// Share for one shown saved revision: a small menu in its viewer's header. It
// exports only what was saved and is on screen: an image's raster bytes, or
// code's exact source as text. There is no capture of a running preview.
import { effect, signal, View } from "nsh";
import { ArtifactExport as NativeExport } from "pilot-day/native";
import type { SavedArtifact, Shown } from "./artifactReads";
import { Caption, Menu, MenuItem, MenuTitle, MenuTrigger } from "./ui";

/** The one export a saved copy supports, or none while nothing usable was read. */
function exportOf(artifact: SavedArtifact | null): string {
	const c = artifact?.content;
	if (c?.state === "image") return "Export image…";
	if (c?.state === "text") return "Export source…";
	return "";
}

/** The one export a shown revision supports, or none while it reads, was refused or is unavailable. */
export function exportLabel(shown: Shown): string {
	return shown.state === "shown" ? exportOf(shown.artifact) : "";
}

/** The title saved with the revision shown; the row's title only until it is read. */
export function savedTitle(shown: Shown): string {
	return (shown.artifact?.metadata.title ?? shown.title) || "Artifact";
}

/** Which saved revision a message is about: one export's answer never shows under another pin. */
function pinOf(artifact: SavedArtifact | null): string {
	return artifact ? JSON.stringify(artifact.reference) : "";
}

/**
 * The share icon and its menu. Opening the menu fixes the saved copy it
 * exports; another pin under the same header closes it. The native exporter
 * asks where to save through the system Save dialog and writes that copy.
 */
export function ShareMenu(props: { shown: Shown; testID: string }) {
	const open = signal(false);
	// The copy the menu was opened for: what it names and exports, whatever shows later.
	const target = signal<SavedArtifact | null>(null);
	const busy = signal(false);
	const said = signal<{ pin: string; text: string } | null>(null);
	const exporter = new NativeExport();
	const label = () => exportLabel(props.shown);
	let shownPin = "";
	effect(() => {
		const pin = pinOf(props.shown.artifact);
		if (pin === shownPin) return;
		shownPin = pin;
		open.set(false);
		target.set(null);
	});
	const message = () => {
		const s = said();
		return s && s.pin === pinOf(props.shown.artifact) ? s.text : "";
	};
	const save = async (artifact: SavedArtifact | null) => {
		if (busy() || !artifact || !exportOf(artifact)) return;
		const pin = pinOf(artifact);
		busy.set(true);
		let text = "";
		try {
			text = await exporter.save(JSON.stringify(artifact));
		} catch {
			text = "Export did not finish. Check the destination before trying again.";
		} finally {
			busy.set(false);
		}
		said.set({ pin, text });
	};
	return (
		<If when={label()}>
			<View class="flex-row items-center gap-2">
				<If when={message()}>
					<View class="max-w-64">
						<Caption role="alert">{message()}</Caption>
					</View>
				</If>
				<Menu
					open={open()}
					onOpenChange={(isOpen) => {
						if (isOpen) target.set(props.shown.state === "shown" ? props.shown.artifact : null);
						open.set(isOpen);
					}}
					align="end"
					trigger={
						<MenuTrigger
							testID={props.testID}
							icon="share"
							accessibilityLabel={`Share ${savedTitle(props.shown)}, revision ${props.shown.pin.revision}`}
							tooltip="Share"
						/>
					}
				>
					<MenuTitle
						label={`${target()?.metadata.title || "Artifact"} · revision ${target()?.reference.revision ?? ""}`}
					/>
					<MenuItem
						testID={`${props.testID}-export`}
						label={busy() ? "Exporting…" : exportOf(target())}
						disabled={busy() || !exportOf(target())}
						onSelect={() => void save(target())}
					/>
				</Menu>
			</View>
		</If>
	);
}
