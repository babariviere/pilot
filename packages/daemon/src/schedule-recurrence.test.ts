import assert from "node:assert/strict";
import { test } from "node:test";
import { RecurrenceCalendar, validateRecurrence } from "./schedule-recurrence.ts";

const calendar = (extra = {}) =>
	new RecurrenceCalendar(validateRecurrence({ every: "day", time: "02:30", timeZone: "Europe/Paris", ...extra }));
const ms = Date.parse;
test("calendar resolves gaps to first valid minute and folds to first instance", () => {
	const c = calendar();
	assert.equal(c.next(ms("2026-03-28T23:00Z")), ms("2026-03-29T01:00Z"));
	assert.equal(c.next(ms("2026-10-24T22:00Z")), ms("2026-10-25T00:30Z"));
	assert.equal(c.latest(ms("2026-10-25T01:45Z")), ms("2026-10-25T00:30Z"));
	assert.equal(c.next(ms("2026-10-25T00:30Z")), ms("2026-10-26T01:30Z"));
	assert.equal(
		calendar({ timeZone: "Australia/Lord_Howe", time: "02:15" }).next(ms("2026-10-03T12:00Z")),
		ms("2026-10-03T15:30Z"),
	);
});
test("weekly Monday boundaries and monthly clamp/leap/year boundaries use stored zone", () => {
	const weekly = calendar({ every: "week", weekday: 5, time: "09:00" });
	const due = ms("2026-10-30T08:00Z");
	assert.equal(weekly.latest(ms("2026-11-02T09:00Z")), due);
	assert.equal(weekly.periodEnd(due), ms("2026-11-01T23:00Z"));
	const monthly = calendar({ every: "month", dayOfMonth: 31, time: "09:00" });
	assert.equal(monthly.next(ms("2024-02-01T00:00Z")), ms("2024-02-29T08:00Z"));
	assert.equal(monthly.next(ms("2025-02-01T00:00Z")), ms("2025-02-28T08:00Z"));
	assert.equal(monthly.next(ms("2025-12-31T09:00Z")), ms("2026-01-31T08:00Z"));
	assert.equal(monthly.count(ms("2025-12-31T08:00Z"), ms("2026-03-31T07:00Z")), 3);
});
test("weekday subsets and bounded calendar counts ignore intervening DST hours", () => {
	const c = calendar({ weekdays: [1, 3, 5], time: "09:00" });
	assert.equal(c.next(ms("2026-10-30T08:00Z")), ms("2026-11-02T08:00Z"));
	assert.equal(c.count(ms("2026-10-23T08:00Z"), ms("2026-11-02T08:00Z")), 4);
	assert.equal(calendar({ timeZone: "UTC" }).count(ms("2000-01-01T00:00Z"), ms("2026-01-01T02:30Z")), 9498);
});
test("invalid recurrence combinations and zones are rejected", () => {
	for (const extra of [
		{ every: "year" },
		{ time: "24:00" },
		{ timeZone: "not/a-zone" },
		{ weekdays: [] },
		{ weekdays: [1, 1] },
		{ weekdays: [0] },
		{ weekday: 1 },
		{ every: "week" },
		{ every: "week", weekday: 8 },
		{ every: "month", dayOfMonth: 0 },
		{ every: "month", dayOfMonth: 32 },
	])
		assert.throws(() => calendar(extra));
});
