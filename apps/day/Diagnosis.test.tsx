import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 2400 } as const;
test("local counts never enable uploads; drafts restore without effects", async () => {
	const app = await open("./DiagnosisFixture.tsx", desktop);
	expect(app.shows("Sends: 0, checks: 0, reads: 1")).toBe(true);
	await app.press("id:privacy-counts");
	await app.press("Restore draft");
	expect(app.shows("Sends: 0, checks: 0, reads: 1")).toBe(true);
	await app.press("id:privacy-save");
	expect(app.shows("Saved. Local collection never enables upload.")).toBe(true);
	expect(app.shows("id:privacy-endpoint")).toBe(false);
	await app.press("id:privacy-details");
	expect(app.texts().some((t) => t.includes("exports and agent replies"))).toBe(true);
});
test("unknown saves block resends and Check only looks up", async () => {
	const app = await open("./DiagnosisFixture.tsx", desktop);
	await app.press("id:privacy-counts");
	await app.press("Next unknown");
	await app.press("id:privacy-save");
	expect(app.enabled("id:privacy-save")).toBe(false);
	await app.press("id:diagnosis-check");
	expect(app.shows("Sends: 1, checks: 1, reads: 1")).toBe(true);
	expect(app.enabled("id:privacy-revoke")).toBe(true);
	await app.press("id:privacy-revoke");
	expect(app.shows("Sends: 2, checks: 1, reads: 1")).toBe(true);
});
test("stale drafts and invalid collectors cannot save", async () => {
	const app = await open("./DiagnosisFixture.tsx", desktop);
	await app.press("id:privacy-remote");
	await app.type("id:privacy-endpoint", "https://collector.test/private-key");
	expect(app.enabled("id:privacy-save")).toBe(false);
	await app.press("Restore draft");
	expect(app.value("id:privacy-endpoint")).toBe("");
	await app.type("id:privacy-endpoint", "https://collector.test/v1/traces");
	await app.press("External edit");
	expect(app.enabled("id:privacy-save")).toBe(false);
});
test("clear requires explicit confirmation and keeps writer uncertainty", async () => {
	const app = await open("./DiagnosisFixture.tsx", desktop);
	await app.press("id:privacy-clear");
	expect(app.shows("Sends: 0, checks: 0, reads: 1")).toBe(true);
	await app.press("id:privacy-clear-confirm");
	expect(app.texts().some((t) => t.includes("app writer: unconfirmed"))).toBe(true);
});
test("opening diagnosis does not start a model and follow-up drafts stay", async () => {
	const app = await open("./DiagnosisFixture.tsx", desktop);
	expect(app.shows("text:Open diagnosis chat")).toBe(true);
	await app.press("id:diagnosis-ask");
	expect(app.enabled("id:diagnosis-start")).toBe(false);
	await app.type("id:diagnosis-question", "Why is planning waiting?");
	await app.press("Restore draft");
	expect(app.value("id:diagnosis-question")).toBe("Why is planning waiting?");
	expect(app.shows("Sends: 0, checks: 0, reads: 1")).toBe(true);
	await app.press("Show reply");
	await app.type("id:diagnosis-reply", "Which evidence is missing?");
	await app.press("Restore draft");
	expect(app.value("id:diagnosis-reply")).toBe("Which evidence is missing?");
	await app.press("id:diagnosis-send");
	expect(app.value("id:diagnosis-reply")).toBe("");
});
