// The project's Artifacts page and a mission's Artifacts section on a
// scripted source with the connected rules (ArtifactsFixture.tsx). Headless:
// no daemon, provider, storage or preview engine.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;
const NSH = "1b2c3d4e-0000-4000-8000-000000000001";
const HTML = "1b2c3d4e-0000-4000-8000-000000000002";

function reads(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Reads:")) ?? "";
}

test("the project page lists saved artifacts and reads one exact revision per press", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	expect(app.texts().includes("NSH, revision 2")).toBe(true);
	expect(app.texts().includes("HTML, revision 4")).toBe(true);
	// Opening the page reads the list, not a source. Previews are not available here.
	expect(reads(app)).toBe("Reads: []");
	expect(app.shows("Preview")).toBe(false);
	await app.press(`id:artifact-source-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	expect(app.texts().includes("Source · HTML · revision 4")).toBe(true);
	await app.press(`id:artifact-source-/chat-a/${NSH}/2`);
	await app.waitFor("export default () => <Text>Revision two</Text>;");
	// Each row keeps its own view; Escape hides the one opened last, then leaves.
	expect(app.texts().includes("<p>Saved page</p>")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.texts().includes("export default () => <Text>Revision two</Text>;")).toBe(false);
	expect(app.texts().includes("<p>Saved page</p>")).toBe(true);
	expect(reads(app)).toBe(`Reads: [${HTML}@4 ${NSH}@2]`);
	// A refused read shows no earlier text.
	await app.press(`id:artifact-source-/chat-b/${HTML}/4`);
	await app.press("Refuse reads");
	await app.press(`id:artifact-source-/chat-b/${HTML}/4`);
	await app.waitFor("This artifact changed or left this project while Pilot read it. Nothing is shown.");
	expect(app.texts().includes("<p>Saved page</p>")).toBe(false);
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

test("a mission groups its links by task and keeps each pinned revision", async () => {
	const app = await open("./ArtifactsFixture.tsx", desktop);
	await app.waitFor("Timeline");
	await app.press("Mission page");
	await app.waitFor("Write the report");
	expect(app.texts().includes("Draw the timeline")).toBe(true);
	expect(app.texts().includes("The mission")).toBe(true);
	expect(app.texts().includes("NSH, revision 1")).toBe(true);
	expect(app.texts().includes("NSH, revision 2 · current")).toBe(true);
	await app.press(`id:artifact-source-t1/chat-a/${NSH}/1`);
	await app.waitFor("export default () => <Text>Revision one</Text>;");
	expect(reads(app)).toBe(`Reads: [${NSH}@1]`);
});
