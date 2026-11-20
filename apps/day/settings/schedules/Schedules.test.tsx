import { expect, open, test } from "nsh/test";

const desktop = { width: 1100, height: 1000, platform: "macos" } as const;
test("schedules disclose holds and repair limits; reading history never starts work", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.waitFor("Automation is off");
	expect(app.texts().some((t) => t.startsWith("Writes: 0"))).toBe(true);
	await app.press("id:schedule-details-row");
	await app.waitFor("Check the deployment and remaining blockers.");
	await app.waitFor("Repair stopped: agent made no progress");
	expect(app.shows("2 of 3 repair follow-ups used · Stopped")).toBe(true);
	await app.press("id:schedule-pause-row");
	await app.waitFor("Paused");
	expect(app.texts().some((t) => t.startsWith("Writes: 1"))).toBe(true);
});
test("uncertain schedule saves keep drafts and only Check looks up status", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.press("id:schedule-details-row");
	await app.press("role:button[Edit…]");
	await app.waitFor("Edit schedule");
	await app.type("id:schedule-message", " Keep the scope.");
	await app.press("Next unknown");
	await app.press("id:schedule-save");
	await app.waitFor("Delivery is unknown. Check status; do not save again.");
	expect(app.value("id:schedule-message")).toBe("Check the deployment and remaining blockers. Keep the scope.");
	expect(app.enabled("id:schedule-save")).toBe(false);
	await app.press("id:schedule-check");
	expect(app.texts().some((t) => t.startsWith("Writes: 1, checks: 1"))).toBe(true);
});
test("restored and stale drafts require current-state review without submitting", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.press("id:schedule-details-row");
	await app.press("role:button[Edit…]");
	await app.press("Restore draft");
	expect(app.enabled("id:schedule-save")).toBe(false);
	await app.press("Prepare new save");
	expect(app.enabled("id:schedule-save")).toBe(true);
	await app.press("External change");
	expect(app.enabled("id:schedule-save")).toBe(false);
	expect(app.texts().some((t) => t.startsWith("Writes: 0"))).toBe(true);
});
test("an accepted replacement fences an older restored editor without offering another save", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.press("id:schedule-details-row");
	await app.press("role:button[Edit…]");
	await app.press("Accepted replacement");
	await app.waitFor("Request saved. This draft will not be sent again.");
	expect(app.enabled("id:schedule-save")).toBe(false);
	expect(app.shows("Prepare new save")).toBe(false);
	await app.press("id:schedule-check");
	expect(app.texts().some((t) => t.startsWith("Writes: 0, checks: 1"))).toBe(true);
});
test("legacy kept drafts preserve text but never become another submission by rebinding", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.press("id:schedule-details-row");
	await app.press("role:button[Edit…]");
	await app.press("Restore legacy draft");
	expect(app.value("id:schedule-message")).toBe("Check the deployment and remaining blockers.");
	expect(app.enabled("id:schedule-save")).toBe(false);
	expect(app.shows("Prepare new save")).toBe(false);
	expect(app.texts().some((t) => t.startsWith("Writes: 0"))).toBe(true);
});
test("Sunday recurrence remains readable for weekly and restricted daily rules", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.press("Sunday rules");
	expect(app.texts().some((t) => t.includes("Weekly, Sun at 09:00 UTC"))).toBe(true);
	expect(app.texts().some((t) => t.includes("Mon, Sun at 10:00 UTC"))).toBe(true);
});
test("an existing schedule can choose and save a target from another choice page", async () => {
	const app = await open("../../SchedulesFixture.tsx", desktop);
	await app.press("Many choices");
	await app.press("id:schedule-details-row");
	await app.press("role:button[Edit…]");
	await app.press("More choices");
	await app.press("Website refresh coordinator");
	await app.press("Agent on another page");
	await app.press("Prepare new save");
	expect(app.enabled("id:schedule-save")).toBe(true);
	await app.press("id:schedule-save");
	await app.waitFor("Saved target: second");
	expect(app.texts().some((t) => t.startsWith("Writes: 1"))).toBe(true);
});
