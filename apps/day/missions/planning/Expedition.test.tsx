// The Wayfinder expedition chart: places keep their spot, the camera stays
// in bounds, and a reader can select, zoom, drag and go back with Escape.
// Mock data only. Headless tests prove behaviour, not the chart's look.
import { expect, open, test } from "nsh/test";
import { PlanFeed, type PlanPage } from "pilot-day/native";
import { largeMap } from "../../app/testing/mockLargeMap";
import { exploreLine, exploreMark } from "../../sources/map/MapRecords";
import {
	changesOf,
	chartOf,
	clampCam,
	homeCam,
	ISLAND_REACH,
	LABEL,
	slots,
	snapshotOf,
	TRAILS_IN,
	zoomAt,
} from "./chartLayout";
import { placeLine } from "./ExpeditionChart";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;
type App = Awaited<ReturnType<typeof open>>;

async function linux(): Promise<PlanPage> {
	const feed = new PlanFeed("wayfinder");
	await feed.open("linux");
	const page = feed.page("linux");
	if (!page) throw new Error("the Linux mission is in planning");
	return page;
}

test("places keep their spot: answers ink ground in place, fog lifts in place, new places take free spots", async () => {
	const page = await linux();
	const before = chartOf(page);
	const spot = (c: ReturnType<typeof chartOf>, id: string) => c.places.find((p) => p.id === id)?.at;
	const settled = page.explorations.map((e) => (e.id === "desktops" ? { ...e, state: "resolved" as const } : e));
	const added = { ...page.explorations[0], id: "new-question", title: "A new question", state: "ready" as const };
	const fog = page.fog.map((f) => (f.id === "a11y" ? { ...f, active: false, became: ["A new question"] } : f));
	const after = chartOf({ ...page, explorations: [...settled, added], fog });
	for (const p of before.places) expect(spot(after, p.id)).toEqual(p.at);
	for (const f of before.fogs) expect(after.fogs.find((x) => x.id === f.id)?.at).toEqual(f.at);
	expect(after.places.find((p) => p.id === "desktops")?.glyph).toBe("flag");
	const taken = new Set(before.places.map((p) => `${p.at.x},${p.at.y}`));
	const fresh = spot(after, "new-question");
	expect(fresh !== undefined && !taken.has(`${fresh.x},${fresh.y}`)).toBe(true);
	// Slots depend on ids in the map's order only: a later id never moves an earlier one.
	const three = slots(["a", "b", "c"], 12);
	const four = slots(["a", "b", "c", "d"], 12);
	for (const id of ["a", "b", "c"]) expect(four.get(id)).toBe(three.get(id));
	expect(
		slots(
			Array.from({ length: 13 }, (_, i) => `q${i}`),
			12,
		).size,
	).toBe(13);
});

test("the chart shows one region, the route and the compass target from the records", async () => {
	const page = await linux();
	const chart = chartOf(page);
	expect(chart.places.length).toBe(page.explorations.length);
	expect(chart.fogs.length).toBe(page.fog.length);
	expect(chart.target).toBe("desktops");
	expect(chart.trails.map((t) => `${t.key}:${t.kind}`)).toEqual([
		"packaging>updates:wait",
		"desktops>fog:a11y:fog",
		"packaging>fog:offline:fog",
	]);
	// The brief at home, round 1, and the open topic round in the region.
	expect(chart.camps.map((c) => `${c.n} ${c.harbor} ${c.title}`)).toEqual([
		"1 home You set out",
		"2 region Round 1",
		"3 region Round 2",
	]);
	expect(chart.legs.length).toBe(1);
	expect(chart.legs[0].latest).toBe(true);
});

test("a data change plays once, for the changed place only; the first look plays nothing", async () => {
	const page = await linux();
	const first = snapshotOf(chartOf(page));
	expect(changesOf(null, first)).toEqual({ ink: [], lift: [], camp: null, leg: null });
	expect(changesOf(first, first)).toEqual({ ink: [], lift: [], camp: null, leg: null });
	const settled = page.explorations.map((e) => (e.id === "desktops" ? { ...e, state: "resolved" as const } : e));
	const fog = page.fog.map((f) => (f.id === "a11y" ? { ...f, active: false } : f));
	const round = {
		id: "linux-3",
		title: "Round 3",
		line: "1 answer, submitted",
		state: "submitted" as const,
		answers: [],
	};
	const next = snapshotOf(chartOf({ ...page, explorations: settled, fog, rounds: [...page.rounds, round] }));
	expect(changesOf(first, next)).toEqual({ ink: ["desktops"], lift: ["a11y"], camp: 4, leg: null });
	// Seen once, it does not play again; a plan proposed later sails a new leg.
	expect(changesOf(next, next)).toEqual({ ink: [], lift: [], camp: null, leg: null });
	const review = snapshotOf(chartOf({ ...page, explorations: settled, fog, stage: "review" }));
	expect(changesOf(first, review).leg).toBe(1);
	// A place that arrives already settled, or fog that goes away, plays nothing.
	const added = { ...page.explorations[0], id: "new", title: "New", state: "resolved" as const };
	const gone = snapshotOf(chartOf({ ...page, explorations: [...page.explorations, added], fog: [] }));
	expect(changesOf(first, gone)).toEqual({ ink: [], lift: [], camp: null, leg: null });
});

test("zoom keeps the point under the pointer, and the camera keeps the chart in view", async () => {
	const chart = chartOf(await linux());
	const frame = { w: 1000, h: 560 };
	const home = homeCam(chart, frame);
	const z = zoomAt(home, 1.45, 400, 300, chart, frame);
	expect(Math.abs((400 - z.tx) / z.s - (400 - home.tx) / home.s) < 0.01).toBe(true);
	const far = clampCam({ s: home.s, tx: -100000, ty: 100000 }, chart, frame);
	expect(far.tx > -chart.width * home.s).toBe(true);
	expect(far.ty < frame.h).toBe(true);
	expect(zoomAt(home, 100, 0, 0, chart, frame).s).toBe(2.4);
});

test("a place opens its field notes; Escape closes them, then the page goes back", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:chart");
	for (const text of [
		"Next on the route",
		"Expedition log",
		"Key to the chart",
		"id:place-wayland",
		"id:place-fog-a11y",
		"id:place-fog-credentials",
		"id:place-home",
		"id:place-dest",
		"id:place-harbor",
		"Fog lifted: Where credentials live",
		"Pilot is here, round 3",
		"points at what needs you",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	expect(app.shows("id:field-notes")).toBe(false);
	await app.press("id:place-wayland");
	await app.waitFor("id:field-notes");
	expect(app.shows("id:field-notes >> Interview · Settled")).toBe(true);
	expect(app.shows("id:field-notes >> Settled by Decision 4. It changed since.")).toBe(true);
	expect(app.shows("id:field-notes >> Decision 4 changed after Pilot cited it.")).toBe(true);
	expect(app.shows("id:field-notes >> Open Decision 4 (changed since)")).toBe(true);
	// Another place replaces the notes; reading them changes nothing.
	await app.press("id:place-fog-a11y");
	await app.waitFor("id:field-notes >> Ready when: Once the desktops are chosen.");
	expect(app.shows("id:field-notes >> Settled by Decision 4. It changed since.")).toBe(false);
	await app.keyboard.press("escape");
	expect(app.shows("id:field-notes")).toBe(false);
	expect(app.shows("id:map")).toBe(true);
	// With nothing to close, Escape leaves the planning page as before.
	await app.keyboard.press("escape");
	await app.waitFor("id:planning");
	expect(app.shows("id:map")).toBe(false);
});

test("the chart on the page is still: no zoom, a scroll or drag over it reaches the page", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:chart");
	expect(app.shows("label:Zoom in")).toBe(false);
	expect(app.shows("label:Zoom out")).toBe(false);
	expect(app.shows("id:open-chart")).toBe(true);
	// The zoom keys do nothing here, and nothing moves.
	await app.keyboard.press("shift+plus");
	await app.keyboard.press("minus");
	expect(app.shows("id:whole-chart")).toBe(false);
	// A scroll over the chart scrolls the page around it, never the chart.
	await app.scroll("id:chart", 400);
	await app.scroll("id:chart", -400);
	// A drag that starts on a place neither moves the chart nor selects the place.
	await app.drag("id:place-scope", { x: 140, y: 40 });
	expect(app.shows("id:field-notes")).toBe(false);
	expect(app.shows("id:whole-chart")).toBe(false);
	expect(app.shows("id:chart-full")).toBe(false);
	// A click still opens the field notes inline.
	await app.press("id:place-scope");
	await app.waitFor("id:field-notes >> Round 1 · your answers, as submitted");
});

test("the chart opens full window by its button or keys; Escape closes notes, then the full view", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:chart");
	// Icon-only buttons: their label and tooltip name them, with the keys.
	expect(app.shows("label:Open chart (⇧⌘M)")).toBe(true);
	expect(app.shows("text:Open chart")).toBe(false);
	await app.press("label:Open chart (⇧⌘M)");
	await app.waitFor("id:chart-full");
	expect(app.shows("id:chart-full >> label:Close chart (Esc)")).toBe(true);
	expect(app.shows("id:chart-full >> text:Close")).toBe(false);
	expect(app.shows("id:chart-full >> id:chart-full-frame")).toBe(true);
	expect(app.shows("id:chart-full >> label:Zoom in")).toBe(true);
	await app.press("id:chart-full >> id:place-wayland");
	await app.waitFor("id:chart-full >> id:field-notes");
	await app.keyboard.press("escape");
	expect(app.shows("id:chart-full >> id:field-notes")).toBe(false);
	expect(app.shows("id:chart-full")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("id:chart-full")).toBe(false);
	expect(app.shows("id:map")).toBe(true);
	expect(app.shows("id:planning")).toBe(false);
	// The keys open and close it too; Close leaves it as Escape does.
	await app.keyboard.press("mod+shift+m");
	await app.waitFor("id:chart-full");
	await app.keyboard.press("mod+shift+m");
	expect(app.shows("id:chart-full")).toBe(false);
	await app.keyboard.press("mod+shift+m");
	await app.waitFor("id:chart-full");
	await app.press("label:Close chart (Esc)");
	expect(app.shows("id:chart-full")).toBe(false);
	// Back on the page, Escape leaves it as before.
	await app.keyboard.press("escape");
	await app.waitFor("id:planning");
});

test("full window, zoom buttons, keys and drags move the chart", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:chart");
	await app.press("id:open-chart");
	await app.waitFor("id:chart-full");
	const full = (selector: string) => `id:chart-full >> ${selector}`;
	expect(app.shows(full("id:whole-chart"))).toBe(false);
	await app.press(full("label:Zoom in"));
	await app.waitFor(full("id:whole-chart"));
	await app.press(full("id:whole-chart"));
	expect(app.shows(full("id:whole-chart"))).toBe(false);
	await app.keyboard.press("shift+plus");
	await app.waitFor(full("id:whole-chart"));
	await app.keyboard.press("minus");
	expect(app.shows(full("id:whole-chart"))).toBe(false);
	for (let i = 0; i < 8 && app.enabled(full("label:Zoom out")); i++) await app.keyboard.press("minus");
	expect(app.enabled(full("label:Zoom out"))).toBe(false);
	await app.press(full("id:whole-chart"));
	for (let i = 0; i < 8 && app.enabled(full("label:Zoom in")); i++) await app.press(full("label:Zoom in"));
	expect(app.enabled(full("label:Zoom in"))).toBe(false);
	await app.press(full("id:whole-chart"));
	// A drag moves the chart and never selects the place it started on.
	await app.drag(full("id:place-scope"), { x: 140, y: 40 });
	expect(app.shows(full("id:field-notes"))).toBe(false);
	await app.waitFor(full("id:whole-chart"));
	await app.press(full("id:place-scope"));
	await app.waitFor(full("id:field-notes >> Round 1 · your answers, as submitted"));
});

/** Answers the open topic interview and submits it: Pilot then settles "Which desktops count". */
async function answerDesktops(app: App) {
	await app.press("id:see-all");
	await app.press("id:question-first >> GNOME and KDE");
	await app.press("id:question-working >> Today, New and chats work; no tray icon");
	await app.press("id:question-packages >> No. One portable package");
	await app.waitFor("3 of 3 answered");
	await app.press("id:submit");
	await app.waitFor("4 settled · 3 open now · 1 waiting · 2 in fog");
}

test("an answer inks its ground once, for that place only; opening the chart plays nothing", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:chart");
	await app.wait(1500);
	for (const id of ["ink-desktops", "ink-scope", "ink-wayland", "ink-keyring", "lift-a11y", "camp-3", "camp-4"])
		expect(app.shows(`id:motion-${id}`)).toBe(false);
	await answerDesktops(app);
	await app.waitFor("id:chart >> id:motion-ink-desktops");
	for (const id of ["ink-scope", "ink-wayland", "ink-keyring", "lift-a11y"])
		expect(app.shows(`id:motion-${id}`)).toBe(false);
	await app.waitUntil(() => !app.shows("id:motion-ink-desktops"), { timeout: 4000 });
	// Played once: later reads, scrolls and the full view play it no more.
	await app.scroll("id:chart", 300);
	await app.press("id:open-chart");
	await app.waitFor("id:chart-full");
	await app.wait(500);
	expect(app.shows("id:motion-ink-desktops")).toBe(false);
});

test("with reduced motion a change shows its end state at once", async () => {
	const app = await open("../../ExpeditionFixture.tsx", { ...desktop, reducedMotion: true });
	await app.waitFor("id:chart");
	await answerDesktops(app);
	await app.waitFor("id:place-desktops >> Your answers, round 2");
	expect(app.shows("id:motion-ink-desktops")).toBe(false);
});

test("a settled question shows how it was settled, never what it still needs", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:chart");
	await app.press("id:settled-toggle");
	await app.waitFor("id:map-settled");
	expect(app.shows("id:explore-scope >> Your answer")).toBe(true);
	expect(app.shows("id:explore-wayland >> Settled")).toBe(true);
	for (const id of ["scope", "wayland", "keyring"]) {
		expect(app.shows(`id:explore-${id} >> Needs your answers`)).toBe(false);
		expect(app.shows(`id:explore-${id} >> Needs research`)).toBe(false);
	}
	// Open questions still say what they need.
	expect(app.shows("id:explore-desktops >> Needs your answers")).toBe(true);
	await app.press("id:place-scope");
	await app.waitFor("id:field-notes >> Interview · Your answer");
	expect(app.shows("id:field-notes >> Needs your answers")).toBe(false);
});

test("the lists below the chart lead to it: the log, the compass and the key", async () => {
	const app = await open("../../ExpeditionFixture.tsx", desktop);
	await app.waitFor("id:expedition-log");
	expect(app.shows("id:log-1 >> You set out")).toBe(true);
	expect(app.shows("id:log-2 >> Round 1")).toBe(true);
	expect(app.shows("id:log-3 >> Questions about “Which desktops count”")).toBe(true);
	await app.press("id:log-2");
	await app.waitFor("id:field-notes >> Planning rounds here");
	expect(app.shows("id:field-notes >> Round 1")).toBe(true);
	await app.press("id:compass");
	await app.waitFor("id:field-notes >> Which desktops count");
	expect(app.shows("id:field-notes >> Its questions for you are open above.")).toBe(true);
	expect(app.shows("id:chart-key >> A fork only you choose. Pilot waits for your answers.")).toBe(true);
	// The outline stays: open now, waiting, settled and fog, each with its record.
	for (const id of ["id:map-now", "id:map-waiting", "id:settled-toggle", "id:fog-toggle", "id:map-plan-step"])
		expect(app.shows(id)).toBe(true);
});

test("a large map stays calm: no label meets another label or island, and many trails into one place hide", async () => {
	const page = largeMap(await linux());
	const chart = chartOf(page);
	expect(chart.places.length).toBe(26);
	// A label sits right of its mark: 16 points left of and above the place, at zoom 1.
	const box = (x: number, y: number) => ({ l: x - 16, t: y - 16, r: x - 16 + LABEL.w, b: y - 16 + LABEL.h });
	const meet = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
		a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
	const labels = chart.places.map((p) => ({ id: p.id, box: box(p.at.x, p.at.y) }));
	for (const a of labels)
		for (const b of labels)
			if (a.id < b.id) expect(`${a.id}/${b.id} ${meet(a.box, b.box)}`).toBe(`${a.id}/${b.id} false`);
	// An island may lie under its own label, never under another one.
	for (const s of chart.places.filter((p) => p.item.state === "resolved")) {
		const land = {
			l: s.at.x - ISLAND_REACH.x,
			t: s.at.y - ISLAND_REACH.y,
			r: s.at.x + ISLAND_REACH.x,
			b: s.at.y + ISLAND_REACH.y,
		};
		for (const a of labels)
			if (a.id !== s.id) expect(`${s.id} under ${a.id} ${meet(land, a.box)}`).toBe(`${s.id} under ${a.id} false`);
	}
	// 42 trails lead into the two places that wait for all 21: they show only when one end is selected.
	const fans = chart.trails.filter((t) => t.fan);
	expect(fans.length).toBe(42);
	expect(new Set(fans.map((t) => t.to))).toEqual(new Set(["features", "prior"]));
	expect(chart.trails.filter((t) => !t.fan).map((t) => t.key)).toEqual([
		"features>retention",
		"prior>retention",
		"retention>acceptance",
	]);
	const features = page.explorations.find((e) => e.id === "features")!;
	expect(features.after.length > TRAILS_IN).toBe(true);
	expect(placeLine(page, features)).toBe("Waits for 21 questions");
	expect(exploreLine(features)).toContain("Day navigation and outcome screens");
});

test("finished research says its findings wait for Pilot; only chats still at work say they work", async () => {
	const page = largeMap(await linux());
	const chart = chartOf(page);
	const at = (id: string) => page.explorations.find((e) => e.id === id)!;
	expect(placeLine(page, at("audit-0"))).toBe("A research chat is working");
	expect(placeLine(page, at("audit-2"))).toBe("Findings wait for Pilot");
	expect(chart.places.find((p) => p.id === "audit-0")?.glyph).toBe("tent");
	expect(chart.places.find((p) => p.id === "audit-2")?.glyph).toBe("tent-done");
	// The marks use the library's seven states now (ui/README.md): the older "still" is the quiet New mark and
	// "moving" is Working. The meaning is the same: finished research waits, a chat at work works.
	expect(exploreMark(at("audit-2"))).toBe("new");
	expect(exploreMark(at("audit-0"))).toBe("working");
	expect(exploreLine(at("audit-2"))).toContain("Findings wait for Pilot");
	expect(placeLine(page, at("safety"))).toBe("Settled");
});

test("the large map's chart, still and full window: selecting a fan-in place lists what it waits for", async () => {
	const app = await open("../../ExpeditionLargeFixture.tsx", desktop);
	await app.waitFor("id:chart");
	expect(app.shows("id:place-features >> Waits for 21 questions")).toBe(true);
	expect(app.shows("id:place-audit-2 >> Findings wait for Pilot")).toBe(true);
	expect(app.shows("id:place-audit-0 >> A research chat is working")).toBe(true);
	await app.press("id:place-features");
	// Its field notes list all 21 it waits for.
	const features = largeMap(await linux()).explorations.find((e) => e.id === "features")!;
	await app.waitFor(`id:field-notes >> ${exploreLine(features)}`);
	const full = await open("../../ExpeditionLargeFullFixture.tsx", desktop);
	await full.waitFor("id:place-features >> Waits for 21 questions");
});
