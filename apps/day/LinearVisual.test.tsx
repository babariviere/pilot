// Mock data, native visual evidence only: Today's Linear tab and the Linear publisher on the shared parts
// (ui/README.md), in light and dark, wide and narrow. Run with `nsh test LinearVisual.test.tsx --target macos`;
// headless runs draw nothing.
import { open, test } from "nsh/test";

// Dark captures fit the screen: a taller window leaves its lower part unpainted.
const SIZES = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("Today's Linear tab: the saved issues and one open issue, in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("./LinearFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:today-tab-linear");
		await app.press("id:today-tab-linear");
		await app.waitFor("id:today-linear >> text:Your issues in cycle 42");
		await app.wait(500);
		await app.screenshot(`output/today-linear-${colorScheme}-${width}.png`);
		await app.press("id:linear-issue-ln-219");
		await app.waitFor("id:linear-detail-ln-219");
		await app.wait(500);
		await app.screenshot(`output/today-linear-open-${colorScheme}-${width}.png`);
	}
});

test("Linear publisher: a preview to publish, in light and dark", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const app = await open("./LinearPublisherFixture.tsx", {
			platform: "macos",
			width: 1100,
			height: 900,
			colorScheme,
		});
		await app.press("id:linear-publisher-open");
		await app.waitFor("Billing Portal · Publishing off");
		await app.press("id:linear-publish-task-declines");
		await app.wait(300);
		await app.screenshot(`output/linear-publisher-parts-select-${colorScheme}-1100.png`);
		await app.press("id:linear-publish-preview");
		await app.waitFor("BIL-200 · Make failed payments recoverable");
		await app.press("id:linear-publish-draft-declines");
		await app.wait(500);
		await app.screenshot(`output/linear-publisher-parts-preview-${colorScheme}-1100.png`);
	}
});
