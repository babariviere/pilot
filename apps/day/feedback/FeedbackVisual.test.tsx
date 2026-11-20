// Actual Day views with fixture data. Run through before-after.sh with --target macos.
import { open, test } from "nsh/test";

async function question() {
	const app = await open("../FeedbackFixture.tsx", { platform: "macos", width: 1000, height: 850 });
	await app.press("id:feedback-open");
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Pilot code");
	await app.type("id:feedback-text", "Search forgets my filter after restarting");
	await app.press("id:feedback-send");
	await app.press("Triage asks");
	await app.waitFor("id:feedback-question-f1");
	return app;
}

test("capture Today feedback question", async () => {
	const app = await question();
	await app.keyboard.press("escape");
	await app.press("id:feedback-new-f1");
	await app.waitFor("id:feedback-question-f1");
	await app.wait(250);
	await app.screenshot("output/today-feedback-question.png");
});

test("capture the displayed feedback fix", async () => {
	const app = await open("../FeedbackFixture.tsx", { platform: "macos", width: 1100, height: 1060 });
	await app.press("id:feedback-open");
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Pilot code");
	await app.type("id:feedback-text", "The plan page hides who works on each task.");
	await app.press("id:feedback-send");
	await app.press("Triage fix");
	await app.waitFor("id:feedback-fix-f1");
	await app.scroll("id:feedback-scroll", 640);
	await app.wait(250);
	await app.screenshot("output/feedback-fix.png");
});

const LOOKS = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

// One test per look: each opens a window and sends feedback, and four in one test pass its time limit.
for (const [colorScheme, width] of LOOKS) {
	test(`Feedback on the parts, ${colorScheme} ${width}`, async () => {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../FeedbackFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:feedback-open");
		await app.press("label:Project where agents triage and fix your feedback");
		await app.press("text:Pilot code");
		await app.type("id:feedback-text", "The plan page hides who works on each task.");
		await app.press("id:feedback-send");
		await app.press("Triage fix");
		await app.waitFor("id:feedback-fix-f1");
		await app.wait(500);
		await app.screenshot(`output/feeds-feedback-${colorScheme}-${width}.png`);
		await app.scroll("id:feedback-scroll", 600);
		await app.wait(300);
		await app.screenshot(`output/feeds-feedback-sent-${colorScheme}-${width}.png`);
	});
}
