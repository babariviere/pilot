// Captures the mockup's three states. Mock data only; run: apps/day/nsh.sh test fixtures/feedback-prototype/FeedbackPrototypeMockup.test.tsx
import { open, test } from "nsh/test";

test("capture the feedback prototype mockup", async () => {
	const app = await open("./FeedbackPrototypeMockup.tsx", {
		platform: "macos",
		width: 900,
		height: 900,
	});
	for (const [tab, name] of [
		["1. Proposal", "proposal"],
		["2. Choose a mockup", "question"],
		["3. Fix from choice", "fix"],
	]) {
		await app.press(`text:${tab}`);
		await app.wait(250);
		await app.screenshot(`output/feedback-prototype-${name}.png`);
	}
});
