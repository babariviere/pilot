import { open, test } from "nsh/test";

test("Chat reply in light and dark, wide and narrow", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		for (const width of [480, 1100]) {
			const app = await open("../ChatReplyFixture.tsx", { platform: "macos", width, height: 700, colorScheme });
			await app.waitFor("The export keeps the header even if the filter returns no rows.");
			await app.press("id:chat-steps-2");
			await app.waitFor("Ran a command");
			await app.type("id:chat-message", "Keep the CSV header and add a test for quoted fields.");
			await app.wait(250);
			await app.screenshot(`output/chat-reply-${colorScheme}-${width}.png`);
		}
	}
});
