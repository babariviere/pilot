// The examples through the same entry Pilot's compiler generates. Headless
// behavior only: no window, GPU, appearance or captured-runtime checks.
import { expect, open, test } from "nsh/test";

const SIZE = { width: 1000, height: 1400, platform: "macos" } as const;

test("summary cards and the comparison table show every value", async () => {
	const app = await open("./entries/summary.tsx", SIZE);
	await app.waitFor("Search index rebuild");
	for (const text of ["4.2 M", "47 min", "Shadow index", "Recommended", "Switch alias back", "1–2 weeks"])
		expect(app.shows(text)).toBe(true);
});

test("charts write their numbers and states as text", async () => {
	const app = await open("./entries/charts.tsx", SIZE);
	await app.waitFor("Test suite health");
	for (const text of [
		"212 s",
		"6.5 s",
		"Low 8.8 min · High 14.1 min · Latest 8.8 min",
		"30 Oct",
		"12 Nov",
		"Now",
		"Done",
	])
		expect(app.shows(text)).toBe(true);
	expect(app.shows("label:daemon: 212 s")).toBe(true);
});

test("the mockup changes only its own local state", async () => {
	for (const reducedMotion of [false, true]) {
		const app = await open("./entries/mockup.tsx", { ...SIZE, reducedMotion });
		await app.waitFor("Showing list; no item open.");
		await app.press("role:button[Cards]");
		await app.waitFor("Showing cards; no item open.");
		await app.press("text:Fix the flaky upload test");
		await app.waitFor("Timeout raised; root cause unknown.");
		expect(app.shows("Showing cards; one item open.")).toBe(true);
		expect(app.requests()).toEqual([]);
		expect(app.openedUrls()).toEqual([]);
		expect(app.storage()).toEqual({});
	}
});

test("a reopened mockup starts fresh", async () => {
	const first = await open("./entries/mockup.tsx", SIZE);
	await first.press("role:button[Cards]");
	await first.waitFor("Showing cards; no item open.");
	const second = await open("./entries/mockup.tsx", SIZE);
	await second.waitFor("Showing list; no item open.");
});

test("the flow diagram draws its steps and link labels in both appearances", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const app = await open("./entries/flow.tsx", { ...SIZE, colorScheme });
		await app.waitFor("Build in a workspace");
		for (const text of ["Request", "From Today or a mission", "Checks", "Ready for you to check", "pass", "fix"])
			expect(app.shows(text)).toBe(true);
		expect(app.shows("id:flow-diagram")).toBe(true);
	}
});

test("the sequence diagram draws participants, messages and notes", async () => {
	const app = await open("./entries/sequence.tsx", SIZE);
	await app.waitFor("Background service");
	for (const text of [
		"You",
		"Press Update",
		"Save open drafts",
		"Running tools stop at a safe point",
		"Restart with drafts kept",
	])
		expect(app.shows(text)).toBe(true);
	expect(app.shows("id:sequence-diagram")).toBe(true);
});

test("a narrow window scrolls a wide diagram instead of squeezing it", async () => {
	const app = await open("./entries/flow.tsx", { ...SIZE, width: 360 });
	await app.waitFor("Ready for you to check");
	await app.scroll("id:flow-diagram", 400);
	expect(app.shows("Ready for you to check")).toBe(true);
});

test("an artifact that throws shows the error instead of a blank page", async () => {
	const app = await open("./entries/broken.tsx", SIZE);
	await app.waitFor("This artifact stopped with an error.");
	expect(app.shows("rows is not iterable")).toBe(true);
});

test("refused data says why and draws nothing in part", async () => {
	const app = await open("./entries/refused.tsx", SIZE);
	await app.waitFor("Refused data");
	for (const text of [
		'A link names "missing", which is not a step.',
		"nodes has 41; the limit is 40.",
		'steps[0].to names "b", which is not a participant.',
		'Bar "Loss" is negative; bars start at zero.',
		"points needs at least 2.",
		'Row "Cost" cells needs at least 2.',
		"nodes must be a list.",
	])
		expect(app.shows(text)).toBe(true);
	expect(app.shows("Start")).toBe(false);
	expect(app.shows("Step 0")).toBe(false);
	expect(app.count("This diagram can't be drawn.")).toBe(4);
});
