// Changes as a user takes them: the list, reopening one exact snapshot as
// history, Later without approval, a lost answer settled only by a check,
// unavailable versus none, and the typed boundary as TSX sees it.
import { expect, open, test } from "nsh/test";
import { type ChangePage, ChangesFeed, type ChangesScenario } from "pilot-day/native";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;

/** Reads one kept snapshot through its own feed, for ids and exact identities. */
async function read(scenario: ChangesScenario, pick: (f: ChangesFeed) => string): Promise<ChangePage> {
	const feed = new ChangesFeed(scenario);
	const id = pick(feed);
	await feed.open({ snapshotId: id });
	const page = feed.change(id);
	feed.dispose();
	if (!page) throw new Error(`no page for ${id}`);
	return page;
}

const byTitle =
	(title: string, group: "waiting" | "later" | "earlier", at = 0) =>
	(f: ChangesFeed) =>
		f.snapshot()[group].filter((r) => r.title === title)[at].snapshotId;

test("Today opens Changes, grouped by review request", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("role:button[Changes, 2 to review]");
	await app.waitFor("To review");
	for (const text of [
		"Only kept snapshots show here, not every change in the project.",
		"Review: History slice",
		"Review: Docs refresh",
		"Later",
		"Review: Search warm-up",
		"Earlier",
		"Review: Quieter notifications",
		"Tidy shell setup",
		"One kept change could not be read here. Not shown, and not counted as none.",
		"One change is still being kept.",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.keyboard.press("escape");
	await app.waitFor("Needs you");
});

test("reopening an older snapshot shows that exact snapshot, as history", async () => {
	const older = await read("review", byTitle("Review: History slice", "earlier"));
	const newer = await read("review", byTitle("Review: History slice", "waiting"));
	expect(older.identity.snapshotId).not.toBe(newer.identity.snapshotId);
	expect(older.newer).toBe(newer.identity.snapshotId);

	const app = await open("./Changes.tsx", desktop);
	await app.press(`id:change-${older.identity.snapshotId}`);
	await app.waitFor("A newer snapshot of this change is kept.");
	expect(
		app.shows(`Head ${older.identity.head.slice(0, 8)} on ${older.identity.base.slice(0, 8)} · layer · committed`),
	).toBe(true);
	expect(app.shows(`The snapshot Pilot kept on ${older.identity.capturedAt}. The files may have changed since.`)).toBe(
		true,
	);
	// The diff shows that snapshot's exact kept lines, not the newer one's.
	await app.waitFor("        self.loaded_older = true;");
	expect(app.shows("        let anchor = self.visible_anchor();")).toBe(false);
	expect(app.shows("No open review request. Earlier requests are in History.")).toBe(true);
	expect(app.shows("1 file changed, +1 −0")).toBe(true);
	expect(app.shows("id:diff")).toBe(true);
	// Nothing to put off or approve on history.
	expect(app.shows("role:button[Later]")).toBe(false);
	expect(app.shows("role:button[Approve]")).toBe(false);

	await app.press("role:tab[History]");
	await app.waitFor("Asked for changes");
	expect(app.shows("The reading position still jumps when older messages arrive. Keep it put.")).toBe(true);
	await app.press("role:button[Snapshot details]");
	await app.waitFor(older.identity.head);
	for (const exact of [older.identity.snapshotId, older.identity.changeId, older.identity.base, older.identity.diff]) {
		expect(app.shows(exact)).toBe(true);
	}
	expect(app.shows(newer.identity.head)).toBe(false);

	await app.press("role:tab[Diff]");
	await app.press("id:newer");
	await app.waitFor("Waiting for your review.");
	expect(
		app.shows(`Head ${newer.identity.head.slice(0, 8)} on ${newer.identity.base.slice(0, 8)} · layer · committed`),
	).toBe(true);
	expect(app.shows("A newer snapshot of this change is kept.")).toBe(false);
	expect(app.shows("2 files changed, +13 −2")).toBe(true);
});

test("a landed change with a historical approval approves nothing now", async () => {
	const notify = await read("review", byTitle("Review: Quieter notifications", "earlier"));
	const app = await open("./Changes.tsx", desktop);
	await app.press(`id:change-${notify.identity.snapshotId}`);
	await app.waitFor("Seen on main 3 h ago. Pilot has not checked since.");
	expect(
		app.shows(
			"Read just now. Reopening approves nothing; an earlier approval stays in History and does not count now.",
		),
	).toBe(true);
	expect(app.shows("role:button[Approve]")).toBe(false);
	await app.press("role:tab[History]");
	await app.waitFor("Approved at the time");
	expect(app.shows("An approval here is of this snapshot, at that time. It does not count now.")).toBe(true);
	expect(app.shows(`Task #4 reported ${notify.identity.head.slice(0, 8)} · 4 h ago`)).toBe(true);
	expect(app.shows("An agent's report, not proof that it landed.")).toBe(true);
});

test("a change seen landed once keeps that, with a later unclear check", async () => {
	const shell = await read("review", byTitle("Tidy shell setup", "earlier"));
	const app = await open("./Changes.tsx", desktop);
	await app.press(`id:change-${shell.identity.snapshotId}`);
	await app.waitFor("Seen on main 2 days ago. A later check could not confirm it.");
	expect(app.shows("Mode changed scripts/bootstrap.sh: No lines for this file in the kept patch.")).toBe(false);
	expect(app.shows("1 file changed, +0 −0")).toBe(true);
});

test("Later defers without approval, and Bring back names the new revision", async () => {
	const docs = await read("review", byTitle("Review: Docs refresh", "waiting"));
	const app = await open("./Changes.tsx", desktop);
	await app.press(`id:change-${docs.identity.snapshotId}`);
	await app.waitFor("Waiting for your review.");
	expect(app.shows("Not kept: 2 images over 1 MiB were not kept.")).toBe(true);
	expect(app.shows("Added docs/day.png: Binary file. No lines to show.")).toBe(true);
	await app.press("role:button[Later]");
	await app.waitFor("Put off. It still waits for your review; nothing was approved.");
	expect(app.shows("You put this off. It still waits for your review.")).toBe(true);
	expect(app.shows("role:button[Later]")).toBe(false);
	await app.press("role:tab[History]");
	await app.waitFor("No saved review of this snapshot.");
	expect(app.shows("Later · revision 2 · just now")).toBe(true);

	await app.press("role:button[Back to Changes]");
	await app.waitFor("To review");
	expect(app.shows("role:button[Review: Docs refresh, Later. Reopen the kept change.]")).toBe(true);
	expect(app.shows("role:button[Review: History slice, Waiting for your review. Reopen the kept change.]")).toBe(true);

	await app.press(`id:change-${docs.identity.snapshotId}`);
	await app.press("role:button[Bring back]");
	await app.waitFor("Back with the changes to review.");
	expect(app.shows("Waiting for your review.")).toBe(true);
});

test("L puts the review in front off, and Escape goes back", async () => {
	const newer = await read("review", byTitle("Review: History slice", "waiting"));
	const app = await open("./Changes.tsx", desktop);
	await app.press(`id:change-${newer.identity.snapshotId}`);
	await app.waitFor("Waiting for your review.");
	await app.keyboard.press("l");
	await app.waitFor("Put off. It still waits for your review; nothing was approved.");
	await app.keyboard.press("escape");
	await app.waitFor("To review");
	expect(app.shows("Nothing waits for your review.")).toBe(false);
	await app.keyboard.press("escape");
	await app.waitFor("Pilot");
	expect(app.shows("To review")).toBe(false);
});

test("a lost answer stays unconfirmed until Check again reads it", async () => {
	const docs = await read("trouble", byTitle("Review: Docs refresh", "waiting"));
	const app = await open("./ChangesTrouble.tsx", desktop);
	await app.press(`id:change-${docs.identity.snapshotId}`);
	await app.waitFor("role:button[Later]");
	await app.press("role:button[Later]");
	await app.waitFor("Pilot sent it but heard nothing back. It sends nothing more until it checks.");
	expect(app.shows("Unconfirmed")).toBe(true);
	expect(app.shows("role:button[Later]")).toBe(false);
	await app.press("role:button[Check again]");
	await app.waitFor(
		"It arrived. Nothing was sent again. Put off. It still waits for your review; nothing was approved.",
	);
	expect(app.shows("You put this off. It still waits for your review.")).toBe(true);
	expect(app.shows("role:button[Check again]")).toBe(false);
});

test("unavailable is never shown as none", async () => {
	const off = await open("./ChangesOff.tsx", desktop);
	await off.waitFor("Pilot cannot show kept changes here.");
	expect(off.shows("This is not the same as having none.")).toBe(true);
	expect(off.shows("No kept changes yet. Pilot keeps a snapshot when an agent finishes a change.")).toBe(false);

	const empty = await open("./ChangesEmpty.tsx", desktop);
	await empty.waitFor("No kept changes yet. Pilot keeps a snapshot when an agent finishes a change.");
	expect(empty.shows("Pilot cannot show kept changes here.")).toBe(false);
	expect(empty.shows("To review")).toBe(false);
});

test("many kept changes read twenty at a time; a long diff stays one view", async () => {
	const feed = new ChangesFeed("large");
	const first = feed.snapshot().waiting[0].snapshotId;
	feed.more();
	const all = feed.snapshot();
	// The daemon reads oldest first; a later page holds newer kept changes.
	const second = all.earlier[0].snapshotId;
	feed.dispose();

	const app = await open("./ChangesLarge.tsx", desktop);
	await app.waitFor("Read more");
	expect(app.shows(`id:change-${second}`)).toBe(false);
	await app.press("role:button[Read more]");
	await app.waitFor(`id:change-${second}`);
	await app.press(`id:change-${first}`);
	await app.waitFor("1 file changed, +1200 −0");
	expect(app.shows("id:diff")).toBe(true);
});

test("intents are typed: TSX names the snapshot, request and revision shown, nothing more", async () => {
	const feed = new ChangesFeed("review");
	const docs = byTitle("Review: Docs refresh", "waiting")(feed);
	const closed = await feed.later({ snapshotId: docs, requestId: "x", revision: 1 });
	expect(closed.status).toBe("rejected");
	await feed.open({ snapshotId: docs });
	const page = feed.change(docs) as ChangePage;
	const request = page.request;
	if (!request) throw new Error("no request");
	let forged = "";
	await feed
		.later({ snapshotId: docs, requestId: request.requestId, revision: request.revision, approve: true } as never)
		.catch((error: unknown) => {
			forged = String(error);
		});
	expect(forged).toContain("TypeError");
	let fraction = "";
	await feed.later({ snapshotId: docs, requestId: request.requestId, revision: 1.5 }).catch((error: unknown) => {
		fraction = String(error);
	});
	expect(fraction).toContain("TypeError");
	const stale = await feed.later({ snapshotId: docs, requestId: request.requestId, revision: 9 });
	expect(stale.status).toBe("stale");
	expect(feed.change(docs)?.row.attention).toBe("waiting");
	const missing = await feed.open({ snapshotId: "snap_missing" });
	expect(missing.status).toBe("rejected");
	expect(feed.change("snap_missing")).toBeNull();
	feed.dispose();
});
