import { Image, signal, Text, View } from "nsh";
import { ArtifactExport } from "./ArtifactExport";
import type { Shown } from "./artifactReads";
import { Action } from "./ui";

/** Only validated inline raster bytes reach Image. No file or network URL. */
export function SavedImage(props: { inspection: Shown }) {
	const failed = signal(false);
	const attempt = signal(0);
	const saved = () => props.inspection.artifact;
	const source = () => {
		const c = saved()?.content;
		return c?.state === "image" ? c.source : "";
	};
	return (
		<View testID="artifact-image" class="gap-2">
			<Text class="text-xs text-faint">{`${props.inspection.title} · Image · revision ${props.inspection.pin.revision}`}</Text>
			<If when={source()}>
				<Each of={[attempt()]} key={String}>
					{() => <Image src={source()} class="h-96 w-full object-contain" onError={() => failed.set(true)} />}
				</Each>
				<If when={failed()}>
					<Text role="alert" class="text-sm text-muted-foreground">
						This saved image could not be drawn. You can still export its original bytes.
					</Text>
					<Action
						label="Retry image"
						onPress={() => {
							failed.set(false);
							attempt.update((n) => n + 1);
						}}
					/>
				</If>
				<ArtifactExport artifact={saved()!} />
			</If>
		</View>
	);
}
