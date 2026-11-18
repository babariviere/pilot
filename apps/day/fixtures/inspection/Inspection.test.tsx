import { expect, open, test } from "nsh/test";

test("closing the native inspection window keeps the main draft", async () => {
	const app = await open("./App.tsx", { platform: "macos", width: 900, height: 700 });
	await app.type("id:draft", "Keep my draft 日本語");
	await app.press("Open in new window");
	const inspection = app.window("inspection");
	await app.waitUntil(() => inspection.state() !== null);
	await inspection.pressClose();
	await app.waitUntil(() => inspection.state() === null);
	expect(app.value("id:draft")).toBe("Keep my draft 日本語");
});
