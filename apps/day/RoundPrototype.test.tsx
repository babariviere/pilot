// The prototype a topic round asks about (RoundPrototypeFixture.tsx). Headless:
// no daemon or preview engine, so the prototype opens as its saved source.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;

test("a topic round shows its prototype and opens the exact pinned revision once", async () => {
	const app = await open("./RoundPrototypeFixture.tsx", desktop);
	await app.waitFor("The prototype");
	expect(app.texts().some((t) => t.startsWith("Pilot made this mock for these questions."))).toBe(true);
	expect(app.texts().includes("Its limits: up to 30 minutes and about $3, with faux/opus.")).toBe(true);
	expect(app.texts().includes("NSH · revision 3")).toBe(true);
	expect(app.texts().includes("Reads: []")).toBe(true);
	await app.press("id:artifact-card-/chat-proto/variants/3");
	await app.waitFor("export default () => <Text>Variant A</Text>;");
	expect(app.texts().includes("Reads: [chat-proto/variants@3]")).toBe(true);
});
