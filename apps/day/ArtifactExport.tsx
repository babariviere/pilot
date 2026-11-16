// Share for one shown saved revision: a small menu in its viewer's header. It
// exports only what was saved and is on screen: an image's raster bytes, or
// code's exact source as text. There is no capture of a running preview.
import { effect, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { ArtifactExport as NativeExport } from "pilot-day/native";
import type { SavedArtifact, Shown } from "./artifactReads";
import { Icon } from "./ui";

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
					<Text role="alert" class="max-w-64 text-xs text-muted-foreground">
						{message()}
					</Text>
				</If>
				<Menu
					open={open()}
					onOpenChange={(e) => {
						if (e.open) target.set(props.shown.state === "shown" ? props.shown.artifact : null);
						open.set(e.open);
					}}
					align="end"
					offset={4}
					popupClass="min-w-56 rounded-xl border border-border bg-popover p-1 shadow-md"
					trigger={
						<View
							testID={props.testID}
							role="button"
							accessibilityLabel={`Share ${savedTitle(props.shown)}, revision ${props.shown.pin.revision}`}
							tooltip="Share"
							class="min-h-8 min-w-8 items-center justify-center rounded-lg px-2 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<Icon name="share" />
						</View>
					}
				>
					<Text class="px-2.5 pb-1 pt-1.5 text-xs text-faint">
						{`${target()?.metadata.title || "Artifact"} · revision ${target()?.reference.revision ?? ""}`}
					</Text>
					<MenuItem
						testID={`${props.testID}-export`}
						disabled={busy() || !exportOf(target())}
						onSelect={() => void save(target())}
						class="rounded-lg px-2.5 py-1.5 hover:bg-accent focus:bg-accent disabled:opacity-50"
					>
						<Text class="text-sm text-popover-foreground">{busy() ? "Exporting…" : exportOf(target())}</Text>
					</MenuItem>
				</Menu>
			</View>
		</If>
	);
}
