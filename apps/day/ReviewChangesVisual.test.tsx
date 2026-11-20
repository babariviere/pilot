// The reviewed flows with invented projects. Only opens views and reads fixture data.
import { open, test } from "nsh/test";

test("Today, a waiting mission and New across appearances and widths", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		for (const width of [1100, 480]) {
			const size = { platform: "macos", width, height: 850, colorScheme } as const;
			const today = await open("./ScopeFixture.tsx", size);
			await today.press("Global window");
			await today.press("Website requests only");
			await today.press("Empty billing");
			await today.waitFor("id:scope-needs-demo-website");
			await today.wait(250);
			await today.screenshot(`output/review-today-${colorScheme}-${width}.png`);
			const mission = await open("./MissionOverviewFixture.tsx", size);
			await mission.press("id:situation-waiting");
			await mission.waitFor("id:now-search-3");
			await mission.wait(250);
			await mission.screenshot(`output/review-mission-${colorScheme}-${width}.png`);
			const form = await open("./NewPlansFixture.tsx", size);
			await form.press("Turn planning off");
			await form.waitFor("Tasks created");
			await form.wait(250);
			await form.screenshot(`output/review-new-${colorScheme}-${width}.png`);
		}
	}
});
