// The library's image files: its icons and the marks' own images. The library's index imports this module once,
// and it registers the files with icon.tsx. A small app that loads parts file by file from another folder skips it
// (an app ships only files inside its directory); its icons then draw nothing.
import archive from "../icons/archive.svg";
import back from "../icons/back.svg";
import changes from "../icons/changes.svg";
import chat from "../icons/chat.svg";
import check from "../icons/check.svg";
import chevron from "../icons/chevron.svg";
import close from "../icons/close.svg";
import document from "../icons/document.svg";
import fullscreen from "../icons/fullscreen.svg";
import fullscreenExit from "../icons/fullscreen-exit.svg";
import markCheck from "../icons/mark-check.svg";
import markReady from "../icons/mark-ready.svg";
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
import { registerImages } from "./icon";

registerImages({
	archive,
	back,
	changes,
	chat,
	check,
	chevron,
	close,
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
	"mark-check": markCheck,
	"mark-ready": markReady,
});
