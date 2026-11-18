// The screen agent's bar with a scripted conversation. Headless: no native look, focus or pointer checks.
import { expect, open, test } from "nsh/test";

test("Command+J shows the bar; a question shows the latest answer; Esc hides it", async () => {
	const app = await open("./ScreenAgentBarFixture.tsx", { platform: "macos", width: 1000, height: 800 });
	expect(app.shows("id:screen-agent")).toBe(false);
	await app.keyboard.press("mod+j");
	await app.waitFor("id:screen-agent");
	await app.type("id:screen-agent-words", "Is New 4 wrong?");
	await app.submit("id:screen-agent-words");
	await app.waitFor("text:New counts the items it shows.");
	expect(app.value("id:screen-agent-words")).toBe("");
	await app.keyboard.press("escape");
	expect(app.shows("id:screen-agent")).toBe(false);
	await app.keyboard.press("mod+j");
	await app.waitFor("text:New counts the items it shows.");
});

test("Make feedback asks for a draft, shows it to edit, and the person sends it", async () => {
	const app = await open("./ScreenAgentBarFixture.tsx", { platform: "macos", width: 1000, height: 800 });
	await app.keyboard.press("mod+j");
	await app.type("id:screen-agent-words", "Is New 4 wrong?");
	await app.submit("id:screen-agent-words");
	await app.waitFor("id:screen-agent-feedback");
	await app.press("id:screen-agent-feedback");
	await app.waitFor("id:screen-agent-draft-text");
	expect(app.value("id:screen-agent-draft-text")).toBe("New 4 reads as a wrong count.");
	await app.waitFor("text:With the last picture of this window. This conversation becomes its triage.");
	await app.press("id:screen-agent-send-feedback");
	await app.waitFor("text:Feedback saved. This conversation is its triage now.");
});
