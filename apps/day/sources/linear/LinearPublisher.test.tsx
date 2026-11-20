import { expect, open, test } from "nsh/test";

test("Linear preview shows exact scope, then one publish and a read-only status check", async () => {
	const app = await open("../../LinearPublisherFixture.tsx", { platform: "macos", width: 1100, height: 1150 });
	await app.press("id:linear-publisher-open");
	await app.waitFor("Billing Portal · Publishing off");
	await app.press("id:linear-publish-task-declines");
	await app.press("id:linear-publish-task-retry");
	await app.press("id:linear-publish-preview");
	await app.waitFor("BIL-200 · Make failed payments recoverable");
	await app.waitFor("#1 Explain a declined payment blocks #2 Offer a safe retry · Add link");
	await app.waitFor("Publishing is off for this project.");
	expect(app.shows("read → preview")).toBe(true);
	await app.press("Project setting");
	await app.press("id:linear-publish-enable");
	await app.waitFor("Billing Portal · Publishing on");
	await app.press("id:linear-publish-preview");
	await app.press("id:linear-publish-draft-declines");
	await app.waitFor("Outcome");
	await app.waitFor("Acceptance criteria");
	await app.waitFor("Simulate a card decline.");
	expect(app.texts().some((text) => text.includes("## Outcome"))).toBe(false);
	await app.press("id:linear-publish-confirm");
	await app.waitFor("read → preview → setting → preview → publish → check");
	await app.press("id:linear-publish-check");
	await app.waitFor("read → preview → setting → preview → publish → check → check");
	expect(app.shows("id:linear-publish-confirm")).toBe(false);
});
