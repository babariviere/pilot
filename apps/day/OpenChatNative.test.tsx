// Capture the existing screens that now share the chat-bubbles action.
import { open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;

test("open chat pair mission", async () => {
	const app = await open("./MissionOverviewFixture.tsx", desktop);
	await app.waitFor("id:now-search-3");
	await app.screenshot("output/open-chat-mission.png");
	await app.press("id:now-chat-search-3");
	await app.waitFor("Read only. Reading it sends nothing and changes nothing.");
	await app.press("id:back");
	await app.waitFor("id:now-search-3");
});

test("open chat pair feedback", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:feedback-open");
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Pilot code");
	await app.type("id:feedback-text", "Inspect the native activity list");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-open-triage-f1");
	await app.scroll("id:feedback-open-triage-f1", 300);
	await app.screenshot("output/open-chat-feedback.png");
});

test("open chat pair diagnosis", async () => {
	const app = await open("./DiagnosisFixture.tsx", desktop);
	await app.waitFor("Why did planning wait?");
	await app.scroll("text:Why did planning wait?", 500);
	await app.screenshot("output/open-chat-diagnosis.png");
});

test("open chat pair planning repair", async () => {
	const app = await open("./UnstickFixture.tsx", desktop);
	await app.press("id:unstick");
	await app.press("id:repair-start");
	await app.waitFor("id:repair-looking");
	await app.screenshot("output/open-chat-repair.png");
});

test("open chat pair new", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("role:button[New]");
	await app.type("id:goal", "Inspect native activity");
	await app.press("label:Project for a new chat");
	await app.press("text:pilot");
	await app.press("role:button[Start as one chat]");
	await app.press("role:button[Start chat]");
	await app.waitFor("A chat in pilot");
	await app.screenshot("output/open-chat-new.png");
});

test("open chat pair previous mission", async () => {
	const app = await open("./MigrationFixture.tsx", desktop);
	await app.press("id:previous-mission");
	await app.waitFor("id:previous-chat-old-task");
	await app.screenshot("output/open-chat-previous.png");
});
