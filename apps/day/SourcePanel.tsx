// One shown saved source: its title, kind and revision, then the saved text
// exactly as stored, or why it is not shown. Plain text only; nothing runs it.
import { signal, Text, View } from "nsh";
import type { Shown } from "./artifactReads";
import { excerpt, kindName, sizeOf, unavailableLine } from "./deliveryView";
import { Action } from "./ui";

export function SourcePanel(props: { inspection: Shown }) {
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
		<View testID="artifact-source" selectable class="gap-2 rounded-xl bg-muted px-4 py-3">
			<Text class="text-xs text-faint">{`Source · ${kindName(i().kind)} · revision ${i().pin.revision}`}</Text>
			<If when={saved()}>
				<Text role="header" class="text-sm font-medium text-foreground">
					{saved()?.metadata.title || i().title || "Artifact"}
				</Text>
			</If>
			<If when={i().state === "reading"}>
				<Text class="text-sm text-muted-foreground">Reading the saved source…</Text>
			</If>
			<If when={i().state === "refused"}>
				<Text role="alert" testID="artifact-source-refused" class="text-sm text-muted-foreground">
					{i().message}
				</Text>
			</If>
			<If when={text()}>
				<Text testID="artifact-source-text" class="font-mono text-xs leading-relaxed text-foreground">
					{text()?.text ?? ""}
				</Text>
				<If when={text()?.note}>
					<View class="flex-row items-center gap-3">
						<Text class="flex-1 text-xs text-faint">{text()?.note ?? ""}</Text>
						<Action label="Show all" testID="artifact-source-all" onPress={() => all.set(true)} />
					</View>
				</If>
				<Text class="text-xs text-faint">{`Saved copy, ${sizeOf(bytes())}.`}</Text>
			</If>
			<If when={unavailable()}>
				<Text testID="artifact-source-unavailable" class="text-sm text-muted-foreground">
					{unavailable()}
				</Text>
			</If>
			<Text class="text-xs text-faint">
				Plain text from this saved revision. Pilot does not run or draw it, and looking records nothing.
			</Text>
		</View>
	);
}
