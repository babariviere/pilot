// Actual Day views with fixture data. Run through before-after.sh with --target macos.
import { open, test } from "nsh/test";

async function question() {
	const app = await open("./FeedbackFixture.tsx", { platform: "macos", width: 1000, height: 850 });
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
