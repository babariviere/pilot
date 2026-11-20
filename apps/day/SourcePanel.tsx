// One shown saved revision's content only: the saved text exactly as stored, a
// saved raster image, or why it is not shown. Its viewer's header names it and
// offers Share. Raster images draw; code never runs here.
import { signal, View } from "nsh";
import type { Shown } from "./artifactReads";
import { excerpt, sizeOf, unavailableLine } from "./deliveryView";
import { SavedImage } from "./SavedImage";
import { Body, Caption, Link, Quote } from "./ui";

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
		<View testID="artifact-source" class={`gap-2 ${props.fill ? "min-h-0 flex-1" : ""}`}>
			<If when={i().state === "reading"}>
				<Body tone="muted">Reading the saved source…</Body>
			</If>
			<If when={i().state === "refused"}>
				<Body role="alert" testID="artifact-source-refused" tone="muted">
					{i().message}
				</Body>
			</If>
			<If when={text()}>
				{/* Only the saved text is selectable, so a double click never lands on a control. */}
				<Quote code testID="artifact-source-text" text={text()?.text ?? ""} />
				<If when={text()?.note}>
					<View class="flex-row items-center gap-3">
						<Caption tone="faint" grow>
							{text()?.note ?? ""}
						</Caption>
						<Link label="Show all" testID="artifact-source-all" onPress={() => all.set(true)} />
					</View>
				</If>
				<Caption tone="faint">{`Saved copy, ${sizeOf(bytes())}.`}</Caption>
			</If>
			<If when={saved()?.content.state === "image"}>
				<SavedImage inspection={i()} fill={props.fill} />
			</If>
			<If when={unavailable()}>
				<Body testID="artifact-source-unavailable" tone="muted">
					{unavailable()}
				</Body>
			</If>
			<If when={i().kind !== "image"}>
				<Caption tone="faint">
					Plain text from this saved revision. Pilot does not run or draw it, and looking records nothing.
				</Caption>
			</If>
		</View>
	);
}
