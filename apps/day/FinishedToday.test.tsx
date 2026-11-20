import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;
const section = "id:finished-today";

test("Today shows finished chats with local finish times, not review marks", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor(`${section} >> text:Check CSV import edge cases`);
	expect(app.shows(`${section} >> text:11:08`)).toBe(true);
	expect(app.shows("These runs finished. Their results may still need review.")).toBe(true);
	expect(app.shows("Done since you looked")).toBe(false);
});

test("Today distinguishes no finished runs from an unavailable read", async () => {
	const app = await open("./Quiet.tsx", desktop);
	await app.waitFor(`${section} >> text:No chat runs finished today.`);
	expect(app.shows("Finished runs are not available yet.")).toBe(false);
});
