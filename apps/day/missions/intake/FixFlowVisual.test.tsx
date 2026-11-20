// Real Day views with fixture data. These are new surfaces without a Before.
import { open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1050, height: 1050 } as const;

test("capture the linked mission draft", async () => {
	const app = await open("../../NewLinkedFixture.tsx", desktop);
	await app.press("Draft a linked mission");
	await app.waitFor("Your other New draft stays saved.");
	await app.screenshot("output/linked-mission-draft.png");
});

test("capture an editable fix handoff", async () => {
	const app = await open("../../RecoveryFixture.tsx", desktop);
	await app.press("Offer handoff");
	await app.press("id:chat-handoff-prepare");
	await app.type("id:chat-handoff-note", "Keep the original evidence. Finish CSV export.");
	await app.screenshot("output/fix-handoff.png");
});
