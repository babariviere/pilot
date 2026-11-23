import { expect, open, test } from "nsh/test";

for (const [colorScheme, width, reducedMotion] of [
	["light", 1100, false],
	["dark", 1100, false],
	["light", 480, false],
	["dark", 480, false],
	["light", 1100, true],
] as const) {
	const key = `${colorScheme}-${width}${reducedMotion ? "-still" : ""}`;
	test(`working dots in chat and Screen Agent, ${key}`, async () => {
		const app = await open("../WorkingDotsFixture.tsx", {
			platform: "macos",
			width,
			height: 720,
			colorScheme,
			reducedMotion,
		});
		const label = "text:Working… New messages wait until this turn ends.";
		await app.waitFor(label);
		await app.waitFor("id:chat-composer");
		for (let frame = 0; frame < 9; frame++) {
			await app.screenshot(`output/working-chat-${key}-${frame}.png`);
			await app.wait(103);
		}
		await app.keyboard.press("mod+j");
		await app.waitFor("text:Read this window");
		for (let frame = 0; frame < 9; frame++) {
			await app.screenshot(`output/working-agent-${key}-${frame}.png`);
			await app.wait(103);
		}
		await app.keyboard.press("mod+shift+w");
		await app.waitUntil(() => !app.shows("text:Read this window") && !app.shows(label));
		expect(app.shows("id:chat-composer")).toBe(true);
	});
}
