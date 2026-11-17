// The project's Artifacts gallery and a mission's Artifacts section on a
// scripted source with the connected rules (ArtifactsFixture.tsx). Headless:
// no daemon, provider, storage or preview engine, so cards open as text.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;
const NSH = "1b2c3d4e-0000-4000-8000-000000000001";
const HTML = "1b2c3d4e-0000-4000-8000-000000000002";
const IMAGE = "1b2c3d4e-0000-4000-8000-000000000003";
const SHOT_BEFORE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHOT_AFTER = "1b2c3d4e-0000-4000-8000-000000000005";
const SHOT_NEW = "1b2c3d4e-0000-4000-8000-000000000006";
const SAVED = "<p>Saved page</p>";
const BEFORE = "<p>Before page</p>";

function reads(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Reads:")) ?? "";
}

/** The open panel fades out before it closes. */
async function closed(app: { shows(selector: string): boolean; waitUntil(c: () => boolean): Promise<void> }) {
	await app.waitUntil(() => !app.shows("id:artifact-viewer"));
}

/** How many times `text` is on screen: one pane shows it once. */
function copies(app: { texts(): string[] }, text: string): number {
	return app.texts().filter((t) => t === text).length;
}

test("the project gallery shows cards and opens one exact revision per press", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	expect(app.texts().includes("NSH · revision 2")).toBe(true);
	expect(app.texts().includes("HTML · revision 4")).toBe(true);
	// Opening the page reads the list, not a source, and opens nothing.
	expect(reads(app)).toBe("Reads: []");
	expect(app.shows("id:artifact-viewer")).toBe(false);
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	expect(app.texts().includes("Source · HTML · revision 4")).toBe(true);
	// One artifact is open at a time: opening another closes the first.
	await app.press(`id:artifact-card-/chat-a/${NSH}/2`);
	await app.waitFor("export default () => <Text>Revision two</Text>;");
	expect(app.texts().includes("<p>Saved page</p>")).toBe(false);
	// Without the native preview, NSH shows as text with no preview switch.
	expect(app.shows("id:artifact-viewer-toggle")).toBe(false);
	// Escape closes the open artifact first, then leaves.
	await app.keyboard.press("escape");
	await closed(app);
	expect(app.texts().includes("Timeline")).toBe(true);
	expect(reads(app)).toBe(`Reads: [${HTML}@4 ${NSH}@2]`);
	// Pressing the open card closes it, and Close does too.
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await closed(app);
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	await app.press("id:artifact-viewer-close");
	await closed(app);
	// A refused read shows no earlier text.
	await app.press("Refuse reads");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("This artifact changed or left this project while Pilot read it. Nothing is shown.");
	expect(app.texts().includes("<p>Saved page</p>")).toBe(false);
});

test("an open artifact shows in the full window, and Escape comes back to its viewer", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	expect(app.shows("id:artifact-viewer-full")).toBe(false);
	await app.press(`id:artifact-card-/chat-a/${NSH}/2`);
	await app.waitFor("export default () => <Text>Revision two</Text>;");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	expect(app.texts().includes("Timeline · NSH · revision 2")).toBe(true);
	// The viewer stays under the page and gives its pane to the full window: one copy shows.
	expect(app.texts().includes("Showing in the full window. Esc comes back here.")).toBe(true);
	expect(copies(app, "export default () => <Text>Revision two</Text>;")).toBe(1);
	// The full window reads nothing again.
	expect(reads(app)).toBe(`Reads: [${NSH}@2]`);
	// Escape closes the full window first; the page and its gallery stay.
	await app.keyboard.press("escape");
	expect(app.shows("id:artifact-full")).toBe(false);
	expect(app.texts().includes("Timeline")).toBe(true);
	expect(copies(app, "export default () => <Text>Revision two</Text>;")).toBe(1);
	expect(app.texts().includes("Showing in the full window. Esc comes back here.")).toBe(false);
	await app.press("id:artifact-viewer-full");
	await app.press("id:artifact-full-close");
	expect(app.shows("id:artifact-full")).toBe(false);
	expect(app.shows("id:artifact-viewer")).toBe(true);
	expect(reads(app)).toBe(`Reads: [${NSH}@2]`);
});

test("a refused or empty list says so instead of showing artifacts", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press("Reopen refused");
	await app.waitFor("Pilot could not reach its service. This is not the same as having none.");
	expect(app.texts().includes("Timeline")).toBe(false);
	const empty = await open("./ArtifactsFixture.tsx", desktop);
	await empty.waitFor("Timeline");
	await empty.press("Reopen empty");
	await empty.waitFor("No chat in this project has saved an artifact yet.");
});

test("a mission groups its cards by task and keeps each pinned revision", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press("Mission page");
	await app.waitFor("Write the report");
	expect(app.texts().includes("Draw the timeline")).toBe(true);
	expect(app.texts().includes("The mission")).toBe(true);
	expect(app.texts().includes("NSH · revision 1")).toBe(true);
	expect(app.texts().includes("NSH · revision 2 · current")).toBe(true);
	await app.press(`id:artifact-card-t1/chat-a/${NSH}/1`);
	await app.waitFor("export default () => <Text>Revision one</Text>;");
	expect(reads(app)).toBe(`Reads: [${NSH}@1]`);
});

test("search is local and comparison switches one pane between exact versions", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.type("id:artifact-search", "Report");
	expect(app.shows("Timeline")).toBe(false);
	expect(app.shows("Report page")).toBe(true);
	expect(reads(app)).toBe("Reads: []");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	await app.press("id:artifact-compare");
	// The older revision reads once; After stays the pane shown until Before is chosen.
	await app.waitFor("id:artifact-tab-before");
	await app.waitUntil(() => reads(app) === `Reads: [${HTML}@4 ${HTML}@3]`);
	expect(copies(app, SAVED)).toBe(1);
	expect(app.shows(BEFORE)).toBe(false);
	expect(app.texts().includes("Source · HTML · revision 4")).toBe(true);
	await app.press("id:artifact-tab-before");
	await app.waitFor(BEFORE);
	expect(app.shows(SAVED)).toBe(false);
	expect(app.texts().includes("Source · HTML · revision 3")).toBe(true);
	expect(app.texts().includes("Source · HTML · revision 4")).toBe(false);
	await app.press("id:artifact-tab-after");
	await app.waitFor(SAVED);
	expect(app.shows(BEFORE)).toBe(false);
	// Switching reads nothing again.
	expect(reads(app)).toBe(`Reads: [${HTML}@4 ${HTML}@3]`);
	await app.press("id:artifact-compare");
	expect(app.shows("id:artifact-tab-before")).toBe(false);
	expect(copies(app, SAVED)).toBe(1);
	await app.press("id:artifact-viewer-close");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	expect(app.shows(BEFORE)).toBe(false);
	expect(app.shows("id:artifact-tab-before")).toBe(false);
});

test("failed reads retry the same pin, and Share offers only the saved payload", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press("Refuse reads");
	await app.press(`id:artifact-card-/chat-a/${NSH}/2`);
	await app.waitFor("id:artifact-source-refused");
	// Nothing was read, so there is nothing to share or show in the full window.
	expect(app.shows("id:artifact-viewer-share")).toBe(false);
	expect(app.shows("id:artifact-viewer-full")).toBe(false);
	await app.press("Allow reads");
	await app.press("id:artifact-viewer-retry");
	await app.waitFor("export default () => <Text>Revision two</Text>;");
	expect(reads(app)).toBe(`Reads: [${NSH}@2 ${NSH}@2]`);
	// NSH shares its saved source, never a picture of a preview.
	await app.press("id:artifact-viewer-share");
	await app.waitFor("Export source…");
	expect(app.shows("Export image…")).toBe(false);
	expect(app.texts().includes("Timeline · revision 2")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("Export source…"));
	await app.press("id:artifact-viewer-close");
	await app.press(`id:artifact-card-/chat-b/${IMAGE}/1`);
	await app.waitFor("id:artifact-image");
	expect(app.texts().includes("Image · revision 1")).toBe(true);
	// Export moved to the header: the pane itself has no export button.
	expect(app.shows("id:artifact-export")).toBe(false);
	await app.press("id:artifact-viewer-share");
	await app.waitFor("Export image…");
	expect(app.shows("Export source…")).toBe(false);
	expect(app.texts().includes("Screenshot · revision 1")).toBe(true);
});

test("switching cards in one row drops the previous comparison", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-a/${NSH}/2`);
	await app.waitFor("export default () => <Text>Revision two</Text>;");
	await app.press("id:artifact-compare");
	await app.press("id:artifact-tab-before");
	await app.waitFor("export default () => <Text>Revision one</Text>;");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	expect(app.shows("export default () => <Text>Revision one</Text>;")).toBe(false);
	expect(app.shows("id:artifact-tab-before")).toBe(false);
});

test("the full window keeps the chosen side, its menu closes first on Escape, and the viewer comes back on that side", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	await app.press("id:artifact-compare");
	await app.press("id:artifact-tab-before");
	await app.waitFor(BEFORE);
	// The pane's header names the revision shown by the title saved with it, before any full window or menu.
	expect(app.texts().includes("Old report page")).toBe(true);
	// Comparing, both sides share one fixed-height pane.
	expect(app.count("id:artifact-pane")).toBe(1);
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	// The same pin and side as on screen, shown once, and nothing read again. Revision 3
	// keeps the title saved with it, not the newer name of the artifact.
	expect(app.texts().includes("Old report page · HTML · revision 3")).toBe(true);
	expect(app.texts().includes("Before · Source · HTML · revision 3")).toBe(true);
	expect(copies(app, BEFORE)).toBe(1);
	expect(app.shows(SAVED)).toBe(false);
	// Share in the full window names the version shown, as saved. Escape closes its menu, not the window.
	await app.press("id:artifact-full-share");
	await app.waitFor("Export source…");
	expect(app.texts().includes("Old report page · revision 3")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("Export source…"));
	expect(app.shows("id:artifact-full")).toBe(true);
	// The next Escape closes the window; the viewer is back on Before, as it was.
	await app.keyboard.press("escape");
	expect(app.shows("id:artifact-full")).toBe(false);
	expect(copies(app, BEFORE)).toBe(1);
	expect(app.shows(SAVED)).toBe(false);
	expect(app.texts().includes("Source · HTML · revision 3")).toBe(true);
	expect(app.count("id:artifact-pane")).toBe(1);
	// After keeps the current title and the same pane.
	await app.press("id:artifact-tab-after");
	await app.waitFor(SAVED);
	expect(app.texts().includes("Old report page")).toBe(false);
	// The card and the pane's header both name it now.
	expect(copies(app, "Report page")).toBe(2);
	expect(app.count("id:artifact-pane")).toBe(1);
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	expect(app.texts().includes("Report page · HTML · revision 4")).toBe(true);
	await app.keyboard.press("escape");
	expect(reads(app)).toBe(`Reads: [${HTML}@4 ${HTML}@3]`);
});

test("a full window closes with the page it came from and keeps no copy", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	// The gallery page closes under it, as when the project changes (by key: the dialog covers the fixture).
	await app.keyboard.press("mod+shift+e");
	await app.waitFor("No chat in this project has saved an artifact yet.");
	expect(app.shows("id:artifact-full")).toBe(false);
	expect(app.shows(SAVED)).toBe(false);
	expect(reads(app)).toBe(`Reads: [${HTML}@4]`);
});

// Keeping Tab inside the dialog is checked on a real Mac (Native.test.tsx, "artifact fullscreen keeps keyboard
// inside its dialog"): the headless Tab order walks every shown view from the root, not the open dialog only.
test("the full window is a dialog: the keyboard starts on its exit and comes back to the opener", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	// The exit icon has the focus: Return closes the window, and the focus is back on the icon that opened it.
	await app.keyboard.press("enter");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	await app.keyboard.press("enter");
	await app.waitFor("id:artifact-full");
	await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	expect(app.shows("id:artifact-viewer")).toBe(true);
	expect(app.shows("id:artifact-tab-before")).toBe(false);
	expect(copies(app, SAVED)).toBe(1);
	expect(reads(app)).toBe(`Reads: [${HTML}@4]`);
});

test("in a narrow window the comparison tabs keep their width and the commands wrap below them", async () => {
	const app = await open("./ArtifactsFixture.tsx", { platform: "macos", width: 390, height: 900 });
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor(SAVED);
	await app.press("id:artifact-compare");
	// A press on a tab reaches the tab, not a command drawn under it.
	await app.press("id:artifact-tab-before");
	await app.waitFor(BEFORE);
	expect(app.shows("id:artifact-tab-before")).toBe(true);
	expect(app.texts().includes("Old report page")).toBe(true);
	await app.press("id:artifact-tab-after");
	await app.waitFor(SAVED);
	await app.press("id:artifact-compare");
	expect(app.shows("id:artifact-tab-before")).toBe(false);
	expect(reads(app)).toBe(`Reads: [${HTML}@4 ${HTML}@3]`);
});

test("an image fills the full window instead of keeping its page height", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${IMAGE}/1`);
	await app.waitFor("id:artifact-image-view");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	// One image, drawn in the full window's own room, not in a fixed-height pane.
	expect(app.count("id:artifact-image-view")).toBe(1);
	expect(app.shows("id:artifact-pane")).toBe(false);
	expect(app.texts().includes("Screenshot · Image · revision 1")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.count("id:artifact-image-view")).toBe(1);
});

test("a reported screen is one card: its Before and After open together, After first", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press("Reopen with screens");
	await app.waitFor("Today: mission row");
	// One card per screen, named without its side; the Before capture has no card of its own.
	expect(app.texts().includes("Before / After")).toBe(true);
	expect(app.texts().includes("Screen · Before and After")).toBe(true);
	expect(app.texts().includes("Today: mission row (Before)")).toBe(false);
	expect(app.texts().includes("New screen")).toBe(true);
	expect(reads(app)).toBe("Reads: []");
	await app.press(`id:artifact-card-/chat-c/${SHOT_AFTER}/2`);
	await app.waitFor("id:artifact-tab-before");
	// Both captures are read once, at their pinned revisions; no version comparison on a screen.
	expect(reads(app)).toBe(`Reads: [${SHOT_BEFORE}@1 ${SHOT_AFTER}@2]`);
	expect(app.shows("id:artifact-compare")).toBe(false);
	expect(app.texts().includes("Today: mission row (After)")).toBe(true);
	await app.press("id:artifact-tab-before");
	await app.waitFor("Today: mission row (Before)");
	expect(reads(app)).toBe(`Reads: [${SHOT_BEFORE}@1 ${SHOT_AFTER}@2]`);
	// Closing fades the panel out; pressing the card again while it leaves opens it again.
	await app.press("id:artifact-viewer-close");
	await app.press(`id:artifact-card-/chat-c/${SHOT_AFTER}/2`);
	await app.waitFor("id:artifact-tab-before");
	await app.keyboard.press("escape");
	await closed(app);
	// A new screen opens its one capture, with no tabs.
	await app.press(`id:artifact-card-/chat-c/${SHOT_NEW}/1`);
	await app.waitFor("id:artifact-image");
	expect(app.shows("id:artifact-tab-before")).toBe(false);
});
