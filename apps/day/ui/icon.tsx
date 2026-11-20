// One small family of line icons, drawn on a 16-point grid with the same
// stroke. They are template images: the class's tint colors them. They
// stand beside words, never in place of a label the user must guess.
// The image files load in `images.ts`, which the library's index imports, so a small app that takes
// one part file by file from another folder loads no image file outside its directory.
import { Image, type ImageAsset } from "nsh";

/** The name of one of the app's icons. */
export type IconName =
	| "archive"
	| "back"
	| "changes"
	| "chat"
	| "check"
	| "chevron"
	| "close"
	| "document"
	| "fullscreen"
	| "fullscreenExit"
	| "moon"
	| "more"
	| "notes"
	| "pause"
	| "play"
	| "plus"
	| "pointer"
	| "refresh"
	| "rename"
	| "right"
	| "search"
	| "settings"
	| "share"
	| "sun"
	| "update";

/** An icon, or one of the state marks' own images. */
export type ImageName = IconName | "mark-check" | "mark-ready";

const SOURCES: Partial<Record<ImageName, ImageAsset>> = {};

/** Gives the library its image files. `images.ts` calls it once, as the library loads. */
export function registerImages(sources: Record<ImageName, ImageAsset>) {
	Object.assign(SOURCES, sources);
}

/** The file of an icon or a mark. None when the library's images did not load (a part taken on its own). */
export function iconSource(name: ImageName): ImageAsset | undefined {
	return SOURCES[name];
}

/** A 16-point icon beside a label. Screen readers skip it: the label says what it means. */
export function Icon(props: {
	name: IconName;
	/** A `tint-*` token class (default `tint-muted-foreground`). */
	tint?: string;
}) {
	return (
		<Image
			src={iconSource(props.name)}
			fadeDuration={0}
			accessible={false}
			accessibilityElementsHidden
			class={`size-4 ${props.tint ?? "tint-muted-foreground"}`}
		/>
	);
}
