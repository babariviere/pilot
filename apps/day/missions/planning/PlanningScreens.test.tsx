// Real production views with invented data. Run with --target macos for images.
import { open, test } from "nsh/test";

const size = { platform: "macos", width: 1100, height: 900 } as const;

test("planning screens: questions, carryover and New", async () => {
	const app = await open("../../MockApp.tsx", size);
	await app.press("id:plan-export");
	await app.waitFor("What should one export include?");
	await app.screenshot("output/planning-question.png");
	if (app.shows("id:decide-later")) await app.press("id:decide-later");
	else await app.press("id:next");
	await app.press("role:button[Back to Today]");
	await app.press("id:mission-docs");
	await app.press("id:mission-replan-stop");
	await app.press("id:mission-replan-start");
	await app.screenshot("output/planning-carryover.png");
	if (app.shows("id:replan-use-draft")) await app.press("id:replan-use-draft");
	await app.waitFor("id:goal");
	await app.screenshot("output/planning-new.png");
});

test("planning screens: Revisit exact review", async () => {
	const app = await open("../../Revisit.tsx", size);
	await app.press("id:plan-notify");
	await app.press("id:ask-revisit");
	await app.waitFor("Revisit questions");
	await app.press("Only direct mentions of me");
	await app.waitFor("Question 1 of 3 · 1 answered");
	await app.press("id:next");
	await app.press("Drop the email digest");
	await app.waitFor("Question 2 of 3 · 2 answered");
	await app.press("id:next");
	await app.press("Follow macOS Focus");
	await app.waitFor("Question 3 of 3 · 3 answered");
	await app.press("id:next");
	await app.press("id:submit");
	await app.waitFor("id:revision");
	await app.scroll("id:revision", 10000);
	await app.screenshot("output/planning-revisit.png");
});

test("planning screens: new recovery, selective Revisit and migration states", async () => {
	// New fixtures have no Before. The wrapper keeps the older tests' captures.
	const recovery = await open("../../NewRecoveryFixture.tsx", size);
	await recovery.press("label:Project for a new chat");
	await recovery.press("text:pilot");
	await recovery.waitFor("role:button[Create another]");
	await recovery.screenshot("output/planning-new-uncertain.png");
	const revisit = await open("../../RevisitControlFixture.tsx", size);
	await revisit.press("id:plan-notify");
	await revisit.press("id:ask-revisit");
	await revisit.waitFor("Revisit questions");
	await revisit.press("Only direct mentions of me");
	await revisit.waitFor("Question 1 of 3 · 1 answered");
	await revisit.press("id:next");
	await revisit.press("Drop the email digest");
	await revisit.waitFor("Question 2 of 3 · 2 answered");
	await revisit.press("id:next");
	await revisit.press("Follow macOS Focus");
	await revisit.waitFor("Question 3 of 3 · 3 answered");
	await revisit.press("id:next");
	await revisit.press("id:submit");
	await revisit.waitFor("id:revision");
	await revisit.scroll("id:revision", 10000);
	await revisit.press("id:confirm-revision");
	await revisit.screenshot("output/planning-revisit-selective.png");
	const migration = await open("../../MigrationFixture.tsx", size);
	await migration.press("id:migration-review");
	await migration.screenshot("output/planning-migration.png");
	await migration.press("id:migration-finish");
	await migration.waitFor("id:migration-check");
	await migration.press("id:migration-check");
	await migration.waitFor("Migration finished. History and chats kept. No work started.");
	await migration.press("id:previous-mission");
	await migration.waitFor("id:previous-mission-history");
	await migration.screenshot("output/planning-history.png");
});
