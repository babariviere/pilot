// A chat's question with its attached mockup. Mock data only: this proves the
// card and its one read, not the service's question routes.
import { expect, open, test } from "nsh/test";

test("a question's attached mockup opens from the card and is read once", async () => {
	const app = await open("../../QuestionArtifactsFixture.tsx", { platform: "macos", width: 900, height: 700 });
	await app.waitFor("The chat attached this to look at:");
	expect(app.shows("Reads: []")).toBe(true);
	await app.press("id:artifact-card-/chat-7/planning-controls/2");
	await app.waitFor("id:artifact-viewer");
	await app.waitFor("Reads: [chat-7/planning-controls@2]");
});
