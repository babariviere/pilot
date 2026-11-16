// One shown saved revision's content only: the saved text exactly as stored, a
// saved raster image, or why it is not shown. Its viewer's header names it and
// offers Share. Raster images draw; code never runs here.
import { signal, Text, View } from "nsh";
import type { Shown } from "./artifactReads";
import { excerpt, sizeOf, unavailableLine } from "./deliveryView";
import { SavedImage } from "./SavedImage";
import { Action } from "./ui";

/** `fill`: takes the height it is given, so a saved image grows into it (the full window). */
export function SourcePanel(props: { inspection: Shown; fill?: boolean }) {
	const all = signal(false);
	const i = () => props.inspection;
	const saved = () => i().artifact;
	const text = () => {
		const c = saved()?.content;
		return c?.state === "text" ? excerpt(c.source, all()) : null;
	};
	const bytes = () => {
		const c = saved()?.content;
		return c?.state === "text" ? c.containerBytes : 0;
	};
	const unavailable = () => {
		const c = saved()?.content;
		return c?.state === "unavailable" ? unavailableLine(i().kind, c.reason) : "";
	};
	return (
		<View
			testID="artifact-source"
			class={`gap-2 rounded-xl bg-muted px-4 py-3 ${props.fill ? "min-h-0 flex-1" : ""}`}
		>
			<If when={i().state === "reading"}>
				<Text class="text-sm text-muted-foreground">Reading the saved source…</Text>
			</If>
			<If when={i().state === "refused"}>
				<Text role="alert" testID="artifact-source-refused" class="text-sm text-muted-foreground">
					{i().message}
				</Text>
			</If>
			<If when={text()}>
				{/* Only the saved text is selectable, so a double click never lands on a control. */}
				<View selectable>
					<Text testID="artifact-source-text" class="font-mono text-xs leading-relaxed text-foreground">
						{text()?.text ?? ""}
					</Text>
				</View>
				<If when={text()?.note}>
					<View class="flex-row items-center gap-3">
						<Text class="flex-1 text-xs text-faint">{text()?.note ?? ""}</Text>
						<Action label="Show all" testID="artifact-source-all" onPress={() => all.set(true)} />
					</View>
				</If>
				<Text class="text-xs text-faint">{`Saved copy, ${sizeOf(bytes())}.`}</Text>
			</If>
			<If when={saved()?.content.state === "image"}>
				<SavedImage inspection={i()} fill={props.fill} />
			</If>
			<If when={unavailable()}>
				<Text testID="artifact-source-unavailable" class="text-sm text-muted-foreground">
					{unavailable()}
				</Text>
			</If>
			<If when={i().kind !== "image"}>
				<Text class="text-xs text-faint">
					Plain text from this saved revision. Pilot does not run or draw it, and looking records nothing.
				</Text>
			</If>
		</View>
	);
}
