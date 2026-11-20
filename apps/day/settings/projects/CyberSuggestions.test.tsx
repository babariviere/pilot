import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 900, height: 900 } as const;

test("Today asks once per project after two cyber blocks; Allow Cyber and Not now each answer it", async () => {
	const app = await open("../../CyberSuggestionsFixture.tsx", desktop);
	await app.waitFor("id:cyber-suggestion-phishing");
	expect(app.shows("Phishing hit cyber blocks twice. Allow Cyber work in this project?")).toBe(true);
	expect(app.shows("id:cyber-suggestion-harbour")).toBe(true);
	expect(app.shows("id:cyber-suggestion-quiet")).toBe(false);
	await app.press("id:cyber-allow-phishing");
	await app.waitUntil(() => !app.shows("id:cyber-suggestion-phishing"));
	expect(app.shows("Mock data. Actions: allow-profile phishing cyber.")).toBe(true);
	await app.press("id:cyber-not-now-harbour");
	await app.waitUntil(() => !app.shows("id:cyber-suggestion-harbour"));
	expect(app.shows("Mock data. Actions: allow-profile phishing cyber, cyber-not-now harbour.")).toBe(true);
});
