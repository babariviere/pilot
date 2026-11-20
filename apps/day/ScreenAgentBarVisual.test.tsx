// Mock data, native visual evidence only: the screen agent's bar over a few controls, with an answer and with the
// whole conversation, in light and dark. Run with `nsh test ScreenAgentBarVisual.test.tsx --target macos`; headless
// runs draw nothing.
import { open, test } from "nsh/test";

test("the screen agent's bar in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
		["dark", 480],
	] as const) {
		const app = await open("./ScreenAgentBarFixture.tsx", { platform: "macos", width, height: 800, colorScheme });
		await app.keyboard.press("mod+j");
		await app.type("id:screen-agent-words", "Is New 4 wrong?");
		await app.submit("id:screen-agent-words");
		await app.waitFor("text:New counts the items it shows.");
		await app.wait(500);
		await app.screenshot(`output/feeds-agent-bar-${colorScheme}-${width}.png`);
		await app.press("id:screen-agent-conversation");
		await app.waitFor("id:screen-agent-rows");
		await app.wait(300);
		await app.screenshot(`output/feeds-agent-bar-conversation-${colorScheme}-${width}.png`);
	}
});
