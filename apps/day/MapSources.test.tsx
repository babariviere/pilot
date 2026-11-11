import { expect, open, test } from "nsh/test";
import { exactSource } from "./mapSourceContract";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;

test("exact source identity includes mission, map revision, location, kind and canonical id", () => {
	const request = {
		missionId: "m",
		planRevision: 2,
		area: "item" as const,
		recordId: "q",
		kind: "knowledge",
		id: "k",
	};
	const detail = {
		...request,
		title: "K",
		body: "exact",
		currentness: "current" as const,
		check: "",
		provenance: [],
		history: [],
	};
	expect(exactSource(request, detail)).toBe(true);
	for (const key of ["missionId", "area", "recordId", "kind", "id"])
		expect(exactSource(request, { ...detail, [key]: "different" })).toBe(false);
	expect(exactSource(request, { ...detail, planRevision: 3 })).toBe(false);
});

test("original Decision opens in its map context; Back and Escape keep the interview draft", async () => {
	const app = await open("./MapSourceFixture.tsx", desktop);
	await app.press("id:plan-linux");
	await app.press("id:own-first");
	await app.type("id:answer-first", "Keep exact 💬 draft");
	await app.press("id:settled-toggle");
	await app.press("id:explore-wayland");
	await app.press("id:source-wayland-d4 >> role:button");
	await app.waitFor("Keep the original Wayland choice. 💬");
	expect(app.shows("Stale citation. This record is history, not current agreement.")).toBe(true);
	expect(app.shows("Replaced by Decision 5. Original record kept.")).toBe(true);
	expect(app.shows("Canonical decision d4")).toBe(true);
	expect(app.shows("id:interview")).toBe(true);
	await app.press("Back to map");
	expect(app.shows("Keep the original Wayland choice. 💬")).toBe(false);
	expect(app.value("id:answer-first")).toBe("Keep exact 💬 draft");
	await app.press("id:source-wayland-d4 >> role:button");
	await app.waitFor("Keep the original Wayland choice. 💬");
	await app.keyboard.press("escape");
	expect(app.shows("id:map")).toBe(true);
	expect(app.shows("Keep the original Wayland choice. 💬")).toBe(false);
	expect(app.value("id:answer-first")).toBe("Keep exact 💬 draft");
});

test("Knowledge shows cited content and hides it immediately when access changes", async () => {
	const app = await open("./MapSourceFixture.tsx", desktop);
	await app.press("id:plan-linux");
	await app.press("id:settled-toggle");
	await app.press("id:explore-keyring");
	await app.press("id:source-keyring-keyring >> role:button");
	await app.waitFor("Exact cited revision 3.\nObserved keyring evidence.");
	expect(app.shows("Current source. Reading is not approval or acceptance.")).toBe(true);
	await app.press("Revoke source access");
	await app.waitFor(
		"Source unavailable or currentness unknown. Earlier content is hidden. Nothing was answered or accepted.",
	);
	expect(app.shows("Exact cited revision 3.\nObserved keyring evidence.")).toBe(false);
	await app.press("Read source again");
	expect(app.shows("Exact cited revision 3.\nObserved keyring evidence.")).toBe(false);
	expect(app.shows("Source reads: 2")).toBe(true);
});

test("a mismatched source reply is unavailable, never another record's content", async () => {
	const app = await open("./MapSourceFixture.tsx", desktop);
	await app.press("Wrong source reply");
	await app.press("id:plan-linux");
	await app.press("id:settled-toggle");
	await app.press("id:explore-keyring");
	await app.press("id:source-keyring-keyring >> role:button");
	await app.waitFor(
		"Source unavailable or currentness unknown. Earlier content is hidden. Nothing was answered or accepted.",
	);
	expect(app.shows("Exact cited revision 3.\nObserved keyring evidence.")).toBe(false);
});
