import { Text } from "nsh";
import { TextView } from "nsh/base";

/** A selectable, native Markdown preview. Never opens links or loads images. */
export function MarkdownPreview(props: { markdown: string }) {
	return (
		<TextView
			markdown={props.markdown}
			options={{ html: false, math: false }}
			selectable
			links="report"
			classes={{ root: "gap-2 text-sm", heading: "font-semibold", heading2: "mt-1 text-base" }}
			renderImage={(image) => (
				<Text class="text-sm text-muted-foreground">{`Image not loaded: ${image.alt ? `${image.alt} · ` : ""}${image.src}`}</Text>
			)}
		/>
	);
}
