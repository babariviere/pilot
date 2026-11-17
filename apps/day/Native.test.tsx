// Captures and input on a real platform: run with
// `nsh test Native.test.tsx --target macos`. Headless runs draw nothing, so
// the captures only mean something on a target.
import { expect, open, test } from "nsh/test";

const DECIDE = "id:decision >> role:button[Decide]";

test("question help: background, an answered question and waiting notes, captured", async () => {
	const app = await open("./QuestionHelpFixture.tsx", { platform: "macos", width: 1100, height: 1300 });
	await app.press("id:help-first >> More context");
	await app.press("id:help-first >> Ask a question");
	await app.type("id:ask-text-first", "Why these two?");
	await app.press("id:ask-send-first");
	await app.waitFor("GNOME and KDE cover most Linux users.");
	await app.press("id:help-first >> Say it simpler");
	await app.wait(400);
	await app.screenshot("output/question-help-light.png");
});

test("the prototype a topic round asks about, opened as its saved source, captured", async () => {
	const app = await open("./RoundPrototypeFixture.tsx", { platform: "macos", width: 900, height: 700 });
	await app.press("id:artifact-card-/chat-proto/variants/3");
	await app.waitFor("id:artifact-viewer");
	await app.wait(400);
	await app.screenshot("output/round-prototype-light.png");
});

test("the prototype in the full window, captured", async () => {
	const app = await open("./RoundPrototypeFixture.tsx", { platform: "macos", width: 1100, height: 760 });
	await app.press("id:artifact-card-/chat-proto/variants/3");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	await app.wait(400);
	await app.screenshot("output/artifact-full-light.png");
});

// Run with `--filter 'artifact fullscreen'`. Only a real platform shows this: the headless Tab order walks every
// shown view from the root, so it cannot tell a dialog's focus scope from the page under it.
test("artifact fullscreen keeps keyboard inside its dialog", async () => {
	const app = await open("./ArtifactsFixture.tsx", { platform: "macos", width: 1100, height: 850 });
	const reads = () => app.texts().find((t) => t.startsWith("Reads:")) ?? "";
	const HTML = "1b2c3d4e-0000-4000-8000-000000000002";
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	// The exit icon starts with the focus; Return closes, and Return on the restored opener opens it again.
	await app.keyboard.press("enter");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	await app.keyboard.press("enter");
	await app.waitFor("id:artifact-full");
	// Tab and Return stay in the dialog: nothing underneath closes, compares or reads.
	for (let n = 0; n < 4; n++) await app.keyboard.press("tab");
	await app.keyboard.press("enter");
	if (app.shows("Export source…")) {
		await app.keyboard.press("escape");
		await app.waitUntil(() => !app.shows("Export source…"));
	}
	if (app.shows("id:artifact-full")) await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	expect(app.shows("id:artifact-viewer")).toBe(true);
	expect(app.shows("id:artifact-tab-before")).toBe(false);
	expect(reads()).toBe(`Reads: [${HTML}@4]`);
});

test("Unstick with the repair agent's proposed note, captured", async () => {
	const app = await open("./UnstickFixture.tsx", { platform: "macos", width: 900, height: 900 });
	await app.press("id:unstick");
	await app.press("id:repair-start");
	await app.press("id:agent-done");
	await app.waitFor("id:repair-proposal");
	await app.wait(400);
	await app.screenshot("output/unstick-repair-light.png");
});

test("a large expedition chart, still, with a selected place and full window: captures only, no input", async () => {
	const size = { platform: "macos", width: 1100, height: 1400 } as const;
	for (const [entry, file, colorScheme] of [
		["./ExpeditionLargeFixture.tsx", "chart-large-light", "light"],
		["./ExpeditionLargeSelectedFixture.tsx", "chart-large-selected-light", "light"],
		["./ExpeditionLargeFullFixture.tsx", "chart-large-full-light", "light"],
		["./ExpeditionLargeFixture.tsx", "chart-large-dark", "dark"],
		["./ExpeditionLargeFullFixture.tsx", "chart-large-full-dark", "dark"],
	] as const) {
		// Dark captures fit the screen: a taller headless window leaves its lower part unpainted.
		const app = await open(entry, { ...size, colorScheme, ...(colorScheme === "dark" ? { height: 900 } : {}) });
		await app.waitFor("id:place-features");
		await app.wait(600);
		await app.screenshot(`output/${file}.png`);
	}
});

test("Today renders natively and takes pointer, keyboard and text input", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("Three short things need you.");
	await app.screenshot("output/today-light-1100.png");
	await app.press("Say it simpler");
	await app.press("Ask a question");
	await app.type("id:question", "What happens after 18:00? (日本語 ✓)");
	expect(app.value("id:question")).toBe("What happens after 18:00? (日本語 ✓)");
	await app.press("role:button[Ask]");
	await app.waitFor("What happens after 18:00? (日本語 ✓)");
	await app.press("Only failures and questions");
	await app.screenshot("output/today-help-1100.png");
	await app.press(DECIDE);
	await app.waitFor("Quieter notifications has your answer: Only failures and questions.");
	await app.screenshot("output/today-answered-1100.png");
});

test("Today in dark appearance", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900, colorScheme: "dark" });
	await app.waitFor("Three short things need you.");
	await app.screenshot("output/today-dark-1100.png");
});

test("keyboard triage on a real platform: focus, picks, help and a question draft", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("1 of 3");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	await app.keyboard.press("down");
	await app.screenshot("output/today-keys-focus-1100.png");
	await app.keyboard.press("k");
	await app.keyboard.press("v");
	await app.waitFor("id:visual");
	await app.keyboard.press("q");
	await app.keyboard.press("j");
	expect(app.value("id:question")).toBe("j");
	await app.keyboard.press("escape");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	await app.keyboard.press("k");
	expect(app.value("id:question")).toBe("j");
	await app.screenshot("output/today-keys-help-1100.png");
});

test("an action card in light, dark and a narrow window", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
	] as const) {
		const app = await open("./Actions.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.keyboard.press("j");
		await app.waitFor("id:action");
		await app.screenshot(`output/action-${colorScheme}-${width}.png`);
	}
});

test("Today in a narrow window", async () => {
	const app = await open("./Trouble.tsx", { platform: "macos", width: 480, height: 900 });
	await app.waitFor("2 integration tests fail on Linux");
	await app.screenshot("output/trouble-light-480.png");
});

test("Mission overview in light, dark and a narrow window", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
	] as const) {
		const app = await open("./Trouble.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("Paused. Nothing in it runs until you resume it.");
		await app.screenshot(`output/missions-${colorScheme}-${width}.png`);
		await app.press("id:mission-native");
		await app.press("role:button[Pause mission]");
		await app.press("id:pause >> role:button[Pause]");
		await app.waitFor("Pausing did not finish everywhere. Some work needs a look.");
		await app.screenshot(`output/mission-pausing-${colorScheme}-${width}.png`);
	}
});

// Run with `--filter 'delivery screens'`. The first runs on older revisions too, for a Before.

// One window per test: run each with its own `--filter`, such as `--filter 'mission overview work, light 1100'`.
// They use only what older revisions also have, so a Before captures the old overview of the same mock mission;
// the open rows exist only after.
for (const [colorScheme, width] of [
	["light", 1100],
	["dark", 1100],
	["light", 480],
] as const) {
	test(`mission overview work, ${colorScheme} ${width}, captured`, async () => {
		// 900 points tall: a taller window than the display draws black below it.
		const app = await open("./MockApp.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:mission-search");
		await app.waitFor("Latest report");
		await app.wait(400);
		await app.screenshot(`output/mission-work-${colorScheme}-${width}.png`);
		if (app.shows("id:mission-section-tasks")) {
			// Down to the rows, then open two of them in place.
			await app.scroll("id:mission-page", 2000);
			await app.press("id:mission-section-goal");
			await app.press("id:mission-section-tasks");
			await app.scroll("id:mission-page", 300);
			await app.wait(400);
			await app.screenshot(`output/mission-work-open-${colorScheme}-${width}.png`);
		}
	});
}

test("mission work states over the overview fixture, captured: paused, waiting and an older service", async () => {
	const app = await open("./MissionOverviewFixture.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("id:now-search-3");
	for (const name of ["running", "paused", "waiting", "older"]) {
		await app.press(`id:situation-${name}`);
		await app.waitFor(`${name} · update 0`);
		await app.wait(400);
		await app.screenshot(`output/mission-state-${name}-1100.png`);
	}
});

test("mission rows by keyboard on a real platform: names, focus and Space", async () => {
	const app = await open("./MissionOverviewFixture.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("id:now-search-3");
	expect(app.shows("label:Goal and spec. Show it.")).toBe(true);
	// The rows are below the work: scroll to them so the click lands on the screen.
	await app.scroll("id:mission-page", 2000);
	await app.wait(300);
	await app.press("id:mission-section-goal");
	await app.waitFor("id:mission-goal");
	expect(app.shows("label:Goal and spec. Hide it.")).toBe(true);
	// The row keeps the focus after a press, so Space closes it again.
	await app.keyboard.press("space");
	await app.waitUntil(() => !app.shows("id:mission-goal"));
	// A task that moves from Next to Now in a live update keeps its details open and the focus.
	await app.scroll("id:mission-page", -2000);
	await app.wait(300);
	await app.press("id:next-search-4");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("id:now-search-4");
	await app.wait(400);
	await app.screenshot("output/mission-work-moved-focus-1100.png");
	await app.keyboard.press("space");
	await app.waitUntil(() => !app.shows("Open the release pull request with the benchmark chart."));
});

test("mission rows on a real platform: a task the focus left does not take it back when it moves", async () => {
	const app = await open("./MissionOverviewFixture.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("id:now-search-3");
	await app.press("id:next-search-4");
	await app.waitFor("Open the release pull request with the benchmark chart.");
	// Tab moves the focus to another control; the task's row no longer has it.
	await app.keyboard.press("tab");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("id:now-search-4");
	// Space acts on the control that has the focus, not on the task that moved: its details stay open.
	await app.keyboard.press("space");
	await app.wait(300);
	expect(app.shows("id:now-search-4 >> text:Open the release pull request with the benchmark chart.")).toBe(true);
});

test("mission task chats open again and again with real clicks: Now card and Next row", async () => {
	const app = await open("./MissionOverviewFixture.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("id:now-search-3");
	for (let round = 0; round < 2; round++) {
		await app.press("id:now-chat-search-3");
		await app.waitFor("Read only. Reading it sends nothing and changes nothing.");
		await app.press("id:back");
		await app.waitFor("id:now-chat-search-3");
	}
	await app.press("id:situation-paused");
	await app.waitFor("paused · update 0");
	await app.press("id:next-search-4");
	for (let round = 0; round < 2; round++) {
		await app.press("id:next-chat-search-4");
		await app.waitFor("Read only. Reading it sends nothing and changes nothing.");
		await app.press("id:back");
		await app.waitFor("id:next-chat-search-4");
	}
});

// Run with `--filter 'artifacts screen pair'`: the gallery with a reported screen, closed and open.
test("artifacts screen pair: the gallery, captured", async () => {
	const app = await open("./ArtifactsFixture.tsx", { platform: "macos", width: 1100, height: 760 });
	await app.waitFor("Timeline");
	await app.press("Reopen with screens");
	await app.waitFor("Today: mission row");
	await app.wait(400);
	await app.screenshot("output/artifacts-screen-gallery.png");
});

test("artifacts screen pair: the screen open, captured", async () => {
	const app = await open("./ArtifactsFixture.tsx", { platform: "macos", width: 1100, height: 760 });
	await app.waitFor("Timeline");
	await app.press("Reopen with screens");
	await app.press("id:artifact-card-/chat-c/1b2c3d4e-0000-4000-8000-000000000005/2");
	await app.waitFor("id:artifact-image");
	await app.wait(600);
	await app.screenshot("output/artifacts-screen-open.png");
});

test("delivery screens: a worker's result page, captured", async () => {
	const app = await open("./DeliveryFixture.tsx", { platform: "macos", width: 1100, height: 1200 });
	await app.waitFor("id:to-check");
	await app.press("id:check-task.mock-project.native.native-5");
	await app.waitFor("id:your-check");
	await app.wait(600);
	await app.screenshot("output/delivery-screens-page.png");
});

test("delivery screens: the first screen's Before, captured", async () => {
	const app = await open("./DeliveryFixture.tsx", { platform: "macos", width: 1100, height: 1200 });
	await app.waitFor("id:to-check");
	await app.press("id:check-task.mock-project.native.native-5");
	await app.waitFor("id:screens-comparison");
	await app.press("id:screens-tab-before");
	await app.wait(600);
	await app.screenshot("output/delivery-screens-before-tab.png");
});

test("Today offline and unreadable", async () => {
	const offline = await open("./Offline.tsx", { platform: "macos", width: 1100, height: 900 });
	await offline.waitFor("Offline. Pilot's service is not answering. Showing what Pilot read 6 min ago.");
	await offline.screenshot("output/today-offline-1100.png");
	const unreadable = await open("./Unreadable.tsx", {
		platform: "macos",
		width: 480,
		height: 900,
		colorScheme: "dark",
	});
	await unreadable.waitFor("Today could not be read.");
	await unreadable.screenshot("output/today-unreadable-dark-480.png");
});

// The page keeps what the user reads in place: a card that arrives in Now above the screen changes the offset,
// not the place on screen of the section at the top of the screen. The captures show it at the same height.
test("mission page scroll on a real platform: what is at the top of the screen stays when a card arrives above it, captured", async () => {
	const app = await open("./MissionOverviewFixture.tsx", { platform: "macos", width: 1100, height: 500 });
	await app.waitFor("id:now-search-3");
	type Span = { top: number; bottom: number };
	const read = async () => {
		await app.press("id:where");
		await app.waitUntil(() => app.texts().some((t) => t.startsWith("Scroll: ")));
		const line = app.texts().find((t) => t.startsWith("Scroll: ")) ?? "";
		const m = /^Scroll: (\d+) · next (none|-?\d+\.\.-?\d+) · report (none|-?\d+\.\.-?\d+)$/.exec(line);
		const span = (v: string | undefined): Span | null => {
			if (!v || v === "none") return null;
			const [top, bottom] = v.split("..").map(Number);
			return { top, bottom };
		};
		return { scroll: Number(m?.[1] ?? -1), next: span(m?.[2]), report: span(m?.[3]) };
	};
	let before = await read();
	// Drag by what is left to the Next list's top: large steps first, then a small exact one, so a few real drags do.
	for (let i = 0; i < 12 && before.next && before.next.top > 0; i++) {
		await app.scroll("id:mission-page", Math.min(200, Math.max(10, before.next.top + 5)));
		// A real scroll can coast on: read once it rests.
		await app.wait(300);
		before = await read();
	}
	expect(!!before.next && before.next.top <= 0 && !!before.report).toBe(true);
	// The section the user reads: Next when it holds the top of the screen, else the latest report below or at it.
	const name = before.next && before.next.bottom > 0 ? "next" : "report";
	await app.screenshot("output/mission-scroll-before-update.png");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("id:now-search-4");
	await app.wait(300);
	const after = await read();
	const was = before[name] as Span;
	const now = after[name];
	expect(!!now && Math.abs(now.top - was.top) <= 1).toBe(true);
	expect(after.scroll > before.scroll).toBe(true);
	await app.screenshot("output/mission-scroll-after-update.png");
	// Each real drag and read is a round trip to the macOS driver; the page itself waits on nothing.
}, 60_000);
