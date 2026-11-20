import { Image, signal, View } from "nsh";
import type { Shown } from "./artifactReads";
import { Body, Button, Buttons } from "./ui";

/**
 * Only validated inline raster bytes reach Image. No file or network URL. Its viewer's header names and shares it.
 * `fill`: the image takes the height it is given rather than a fixed one, as in the full window.
 */
export function SavedImage(props: { inspection: Shown; fill?: boolean }) {
	const failed = signal(false);
	const attempt = signal(0);
	const saved = () => props.inspection.artifact;
	const source = () => {
		const c = saved()?.content;
		return c?.state === "image" ? c.source : "";
	};
	return (
		<View testID="artifact-image" class={props.fill ? "min-h-0 flex-1 gap-2" : "gap-2"}>
			<If when={source()}>
				<Each of={[attempt()]} key={String}>
					{() => (
						<Image
							testID="artifact-image-view"
							src={source()}
							class={props.fill ? "min-h-0 w-full flex-1 object-contain" : "h-96 w-full object-contain"}
							onError={() => failed.set(true)}
						/>
					)}
				</Each>
				<If when={failed()}>
					<Body role="alert" tone="muted">
						This saved image could not be drawn. Share can still export its original bytes.
					</Body>
					<Buttons>
						<Button
							label="Retry image"
							onPress={() => {
								failed.set(false);
								attempt.update((n) => n + 1);
							}}
						/>
					</Buttons>
				</If>
			</If>
		</View>
	);
}
