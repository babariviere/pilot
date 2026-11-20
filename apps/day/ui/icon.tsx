// One small family of line icons, drawn on a 16-point grid with the same
// stroke. They are template images: the class's tint colors them. They
// stand beside words, never in place of a label the user must guess.
import { Image } from "nsh";
import archive from "../icons/archive.svg";
import back from "../icons/back.svg";
import changes from "../icons/changes.svg";
import chat from "../icons/chat.svg";
import check from "../icons/check.svg";
import chevron from "../icons/chevron.svg";
import document from "../icons/document.svg";
import fullscreen from "../icons/fullscreen.svg";
import fullscreenExit from "../icons/fullscreen-exit.svg";
import moon from "../icons/moon.svg";
import more from "../icons/more.svg";
import notes from "../icons/notes.svg";
import pause from "../icons/pause.svg";
import play from "../icons/play.svg";
import plus from "../icons/plus.svg";
import pointer from "../icons/pointer.svg";
import refresh from "../icons/refresh.svg";
import rename from "../icons/rename.svg";
import right from "../icons/right.svg";
import search from "../icons/search.svg";
import settings from "../icons/settings.svg";
import share from "../icons/share.svg";
import sun from "../icons/sun.svg";
import update from "../icons/update.svg";

const ICONS = {
	archive,
	back,
	changes,
	chat,
	check,
	chevron,
	document,
	fullscreen,
	fullscreenExit,
	moon,
	more,
	notes,
	pause,
	play,
	plus,
	pointer,
	refresh,
	rename,
	right,
	search,
	settings,
	share,
	sun,
	update,
} as const;

/** The name of one of the app's icons. */
export type IconName = keyof typeof ICONS;

/** A 16-point icon beside a label. Screen readers skip it: the label says what it means. */
export function Icon(props: {
	name: IconName;
	/** A `tint-*` token class (default `tint-muted-foreground`). */
	tint?: string;
}) {
	return (
		<Image
			src={ICONS[props.name]}
			fadeDuration={0}
			accessible={false}
			accessibilityElementsHidden
			class={`size-4 ${props.tint ?? "tint-muted-foreground"}`}
		/>
	);
}
