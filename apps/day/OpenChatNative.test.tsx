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
	for (const width of [1100, 720]) {
		await app.setViewport(width, 1400);
		await app.screenshot(`output/open-chat-overview-${width}.png`);
		await app.press("id:mission-section-tasks");
		await app.scroll("id:mission-page", 650);
		await app.screenshot(`output/open-chat-tasks-${width}.png`);
		await app.press("id:mission-section-tasks");
		await app.scroll("id:mission-page", -10000);
	}
});

test("open chat headers long titles", async () => {
	const app = await open("./MissionOverviewFixture.tsx", desktop);
	await app.press("Long chat titles");
	for (const width of [1100, 720]) {
		await app.setViewport(width, 1400);
		await app.screenshot(`output/open-chat-long-mission-${width}.png`);
		await app.press("id:mission-section-tasks");
		await app.scroll("id:mission-page", 650);
		await app.screenshot(`output/open-chat-long-tasks-${width}.png`);
		await app.press("id:mission-section-tasks");
		await app.scroll("id:mission-page", -10000);
	}
});

test("open chat pair feedback", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:feedback-open");
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Pilot code");
	await app.type(
		"id:feedback-text",
		"Inspect the native activity list and keep each chat action at the top right when the saved feedback has a long description.",
	);
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-open-triage-f1");
	await app.scroll("id:feedback-open-triage-f1", 300);
	await app.screenshot("output/open-chat-feedback.png");
	await app.press("Triage fix");
	await app.press("id:feedback-fix-f1");
	await app.waitFor("id:feedback-open-fix-f1");
	// A later triage question and the existing fix keep separate chat destinations.
	await app.press("Triage asks");
	for (const width of [1100, 720]) {
		await app.setViewport(width, 1400);
		await app.scroll("id:feedback-open-fix-f1", 300);
		await app.screenshot(`output/open-chat-feedback-both-${width}.png`);
	}
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
	await app.press("id:agent-done");
	await app.waitFor("id:repair-proposal");
	await app.screenshot("output/open-chat-repair-proposal.png");
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
