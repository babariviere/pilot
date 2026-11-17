// The mission overview's work-first layout over a TSX fixture with invented
// tasks in every work state. Headless: this proves order, lanes, live
// updates, holds and navigation, not the native look, focus rings or scrolling.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const FIXTURE = "./MissionOverviewFixture.tsx";

type App = Awaited<ReturnType<typeof open>>;

async function opened(): Promise<App> {
	const app = await open(FIXTURE, desktop);
	await app.waitFor("id:now-search-3");
	return app;
}

async function situation(app: App, name: string) {
	await app.press(`id:situation-${name}`);
	await app.waitFor(`${name} · update 0`);
}

type Span = { top: number; bottom: number };
type Where = { scroll: number; next: Span | null; report: Span | null };

/** Reads the fixture's Where line: the kept scroll offset and where Next and the report sit on screen. */
async function where(app: App): Promise<Where> {
	const parse = (): Where | null => {
		const line = app.texts().find((t) => t.startsWith("Scroll: ")) ?? "";
		const m = /^Scroll: (\d+) · next (none|-?\d+\.\.-?\d+) · report (none|-?\d+\.\.-?\d+)$/.exec(line);
		const span = (v: string): Span | null => {
			if (v === "none") return null;
			const [top, bottom] = v.split("..").map(Number);
			return { top, bottom };
		};
		return m ? { scroll: Number(m[1]), next: span(m[2]), report: span(m[3]) } : null;
	};
	await app.press("id:where");
	await app.waitUntil(() => parse() !== null);
	return parse() as Where;
}

/** Scrolls the mission page in small steps until the top of the screen is inside the Next list. */
async function scrollIntoNext(app: App): Promise<Where> {
	let at = await where(app);
	for (let i = 0; i < 40 && !(at.next && at.next.top <= 0); i++) {
		await app.scroll("id:mission-page", 30);
		at = await where(app);
	}
	return at;
}

test("opening a mission names the work now, its owner and what is next, without opening the map", async () => {
	const app = await opened();
	for (const text of [
		"Integration tests on Linux",
		"Running the Linux test suite.",
		"Owner: Build · Sonnet",
		"Working",
		"Benchmark review",
		"In review",
		"Owner: Review · Opus",
		"Queued in plan",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	expect(app.shows("id:now-search-8")).toBe(true);
	expect(app.shows("id:next-search-4")).toBe(true);
	// Done tasks are not work now or next.
	for (const id of ["now-search-1", "next-search-1", "next-search-2", "blocked-search-2"]) {
		expect(app.shows(`id:${id}`)).toBe(false);
	}
	// Queued is the plan's queue, never a start.
	expect(app.shows("Running")).toBe(false);
	// The map, interview and plan stay one press away.
	expect(app.shows("id:mission-plan")).toBe(false);
	expect(app.shows("id:mission-section-map")).toBe(true);
	expect(app.shows("Tasks · 8")).toBe(true);
	expect(app.shows("Results and evidence · 2")).toBe(true);
});

test("blockers tell a task dependency from a task marked blocked and an unavailable prerequisite", async () => {
	const app = await opened();
	expect(app.shows("id:blocked-search-5 >> text:Waits for earlier work")).toBe(true);
	expect(app.shows("id:prerequisites-search-5 >> text:#4 Release pull request · To do")).toBe(true);
	expect(app.shows("id:blocked-search-6 >> text:Marked blocked. No blocking prerequisite is recorded.")).toBe(true);
	expect(app.shows("id:prerequisites-search-6")).toBe(false);
	expect(app.shows("id:prerequisites-search-7 >> text:Prerequisite unavailable · Status unknown")).toBe(true);
	expect(app.shows("Prerequisite gone-9 is unavailable; it is not known done.")).toBe(true);
	expect(app.shows("text:/#0/")).toBe(false);
});

test("a Next row opens in place, and the map opens from its row with Back keeping both open", async () => {
	const app = await opened();
	// The queued task's reason shows only once its row is open.
	expect(app.shows("text:/Start permission, capacity and other holds/")).toBe(false);
	await app.press("id:next-search-4");
	await app.waitFor("Open the release pull request with the benchmark chart.");
	expect(app.shows("text:/Start permission, capacity and other holds have not been checked/")).toBe(true);
	await app.press("id:mission-section-map");
	await app.waitFor("id:mission-plan");
	await app.press("id:open-plan");
	await app.waitFor("This mission is not in planning.");
	await app.press("role:button[Back to Mission overview]");
	await app.waitFor("id:mission-plan");
	expect(app.shows("Open the release pull request with the benchmark chart.")).toBe(true);
});

test("a task's chat opens read only from its card, and Back keeps the goal and spec open", async () => {
	const app = await opened();
	await app.press("id:mission-section-goal");
	await app.waitFor("id:mission-brief");
	for (const text of [
		"Show search results in under 200 ms for large workspaces.",
		"Search must answer in under 200 ms for workspaces with 50,000 files.",
		"· Linux and macOS only for this release.",
		"What the mission agreed. They guide the work and approve nothing.",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.press("id:now-chat-search-3");
	await app.waitFor("Read only. Reading it sends nothing and changes nothing.");
	await app.press("id:back");
	await app.waitFor("id:now-search-3");
	expect(app.shows("id:mission-brief")).toBe(true);
});

test("a live update moves a task from Next to Now and keeps its details open, its focus and a title draft", async () => {
	const app = await opened();
	await app.press("id:mission-section-tasks");
	await app.press("id:next-search-4");
	await app.waitFor("Open the release pull request with the benchmark chart.");
	// The update comes from a key, so the focus stays on the task's row.
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("id:now-search-4");
	expect(app.shows("id:next-search-4")).toBe(false);
	expect(app.shows("Writing the release notes.")).toBe(true);
	expect(app.shows("id:prerequisites-search-5 >> text:#4 Release pull request · In progress")).toBe(true);
	expect(app.shows("Nothing is queued in the plan.")).toBe(true);
	// Its details are still open in its card, and the focus followed it: the keyboard closes them.
	expect(app.shows("id:now-search-4 >> text:Open the release pull request with the benchmark chart.")).toBe(true);
	await app.keyboard.press("space");
	await app.waitUntil(() => !app.shows("Open the release pull request with the benchmark chart."));
	// The open Tasks row is still open.
	expect(app.shows("id:task-chat-search-3")).toBe(true);
});

test("a live update keeps a title being renamed, and its keyboard focus", async () => {
	const app = await opened();
	await app.press("role:button[Rename mission]");
	await app.clear("id:mission-title");
	await app.type("id:mission-title", "Search v2");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("id:now-search-4");
	expect(app.value("id:mission-title")).toBe("Search v2");
	await app.keyboard.press("x");
	expect(app.value("id:mission-title")).toBe("Search v2x");
});

test("waiting for you: the task's question is in Now and the mission's decision in Blockers", async () => {
	const app = await opened();
	await situation(app, "waiting");
	await app.waitFor("Which Linux distributions count for the release?");
	expect(app.shows("id:now-search-3 >> text:Waiting for you")).toBe(true);
	expect(app.shows("id:mission-waiting")).toBe(true);
	expect(app.shows("id:mission-waiting >> text:Waiting for you")).toBe(true);
});

test("paused: active held work stays in Now, unstarted held work in Next, and Resume only in the control panel", async () => {
	const app = await opened();
	await situation(app, "paused");
	await app.waitFor("id:mission-held");
	expect(app.shows("id:now-search-3 >> text:Held")).toBe(true);
	expect(app.shows("id:now-search-3 >> text:Mission is paused.")).toBe(true);
	expect(app.shows("id:next-search-4 >> text:Held")).toBe(true);
	expect(app.shows("id:now-search-4")).toBe(false);
	expect(app.shows("No new work starts in this mission until you resume it.")).toBe(true);
	expect(app.count("role:button[Resume]")).toBe(1);
	expect(app.shows("role:button[Pause mission]")).toBe(false);
	expect(app.shows("No prerequisite blockers in this read.")).toBe(false);
	// A hold does not hide what already blocks a task: it stays in Blockers with its prerequisite and reason.
	expect(app.shows("id:blocked-search-5 >> text:Held")).toBe(true);
	expect(app.shows("id:prerequisites-search-5 >> text:#4 Release pull request · To do")).toBe(true);
	expect(app.shows("id:blocked-search-6 >> text:Marked blocked. No blocking prerequisite is recorded.")).toBe(true);
	expect(app.shows("id:blocked-search-7 >> text:Prerequisite unavailable · Status unknown")).toBe(true);
	expect(app.shows("id:now-search-8 >> text:In review")).toBe(true);
});

test("completed: no task is next, and a chat still working after its task is done stays visible", async () => {
	const app = await opened();
	await situation(app, "completed");
	await app.waitFor("Nothing is next.");
	expect(app.shows("id:now-search-3")).toBe(false);
	expect(app.shows("Chats working in this mission")).toBe(true);
	expect(app.shows("id:mission-chat-w-search")).toBe(true);
	expect(app.shows("text:/^Nothing is working/")).toBe(false);
	expect(app.shows("Results and evidence · 8")).toBe(true);
});

test("empty and unread task lists are said plainly and differently", async () => {
	const app = await opened();
	await situation(app, "empty");
	await app.waitFor("Nothing is queued in the plan.");
	await app.press("id:mission-section-tasks");
	await app.waitFor("No tasks yet.");
	expect(app.shows("No prerequisite blockers in this read.")).toBe(true);
	await situation(app, "unread");
	await app.waitFor("Blocked tasks are not known from this read.");
	expect(app.shows("The task list is not available here yet.")).toBe(true);
	expect(app.shows("Nothing is queued in the plan.")).toBe(false);
	expect(app.shows("No tasks yet.")).toBe(false);
});

test("an older service without work states places no task and infers nothing from a status", async () => {
	const app = await opened();
	await situation(app, "older");
	await app.waitFor("id:mission-unplaced");
	expect(app.shows("6 tasks have no work state in this read. Tasks shows their recorded status.")).toBe(true);
	for (const id of ["now-search-3", "now-search-8", "next-search-4", "blocked-search-5"]) {
		expect(app.shows(`id:${id}`)).toBe(false);
	}
	expect(app.shows("No blocked task in this read. Some tasks have no work state.")).toBe(true);
	await app.press("id:mission-section-tasks");
	await app.waitFor("In progress");
	expect(app.shows("Work state unknown")).toBe(false);
});

test("offline keeps the last read of the work and turns Pause and Resume off", async () => {
	const app = await opened();
	await situation(app, "offline");
	await app.waitFor("Pause and Resume need a fresh read.");
	expect(app.shows("id:now-search-3")).toBe(true);
	expect(app.shows("Mission read is up to date.")).toBe(false);
});

// A Scroll has no content anchor in NSH 0.5; the page keeps its own. A card that arrives in Now above the
// screen must not move what the user reads: the offset changes instead, by the card's height.
test("a card that arrives in Now above the screen keeps the Next list where the user reads it", async () => {
	const app = await open(FIXTURE, { platform: "macos", width: 1100, height: 500 });
	await app.waitFor("id:now-search-3");
	const before = await scrollIntoNext(app);
	// The top of the screen is inside the Next list: that is what the user reads.
	expect(!!before.next && before.next.top <= 0 && before.next.bottom > 0).toBe(true);
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("id:now-search-4");
	await app.wait(200);
	const after = await where(app);
	expect(Math.abs((after.next?.top ?? 9999) - (before.next?.top ?? 0)) <= 1).toBe(true);
	expect(after.scroll > before.scroll).toBe(true);
});

test("at the top of the page, the Pause confirmation opens in place and the page stays at the top", async () => {
	const app = await opened();
	expect((await where(app)).scroll).toBe(0);
	await app.press("role:button[Pause mission]");
	await app.waitFor("id:pause >> role:button[Pause]");
	await app.wait(200);
	expect((await where(app)).scroll).toBe(0);
	expect(app.shows("id:pause >> role:button[Pause]")).toBe(true);
});

test("a held Next row links its chat, and the link opens again after Back", async () => {
	const app = await opened();
	await situation(app, "paused");
	await app.press("id:next-search-4");
	await app.waitFor("id:next-chat-search-4");
	for (let round = 0; round < 2; round++) {
		await app.press("id:next-chat-search-4");
		await app.waitFor("Read only. Reading it sends nothing and changes nothing.");
		await app.press("id:back");
		await app.waitFor("id:next-chat-search-4");
	}
});
