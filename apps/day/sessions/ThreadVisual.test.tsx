// Mock data, native visual evidence only: the chat, thread, result and interview screens on the new parts
// (ui/README.md), in light and dark, wide and narrow, to compare with Today's captures. Run with
// `nsh test ThreadVisual.test.tsx --target macos`; headless runs draw nothing.
import { open, test } from "nsh/test";

const SIZES = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("a thread with the coordinator in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../ThreadFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:mission-search");
		await app.press("id:mission-section-discussions");
		await app.press("id:thread-search-scope");
		await app.waitFor("id:thread-panel");
		await app.wait(500);
		await app.screenshot(`output/thread-parts-${colorScheme}-${width}.png`);
	}
});

test("a chat Pilot started in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("../MissionOverviewFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:now-chat-search-3");
		await app.press("id:now-chat-search-3");
		await app.waitFor("id:chat-panel");
		await app.wait(500);
		await app.screenshot(`output/chat-parts-${colorScheme}-${width}.png`);
	}
});

test("a delivered result in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("../DeliveryFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:to-check");
		await app.press("id:check-task.mock-project.native.native-4");
		await app.waitFor("id:your-check");
		await app.wait(600);
		await app.screenshot(`output/delivery-parts-${colorScheme}-${width}.png`);
	}
});

test("an interview round and its answers in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("../InterviewCardFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:interview");
		await app.wait(400);
		await app.screenshot(`output/interview-parts-${colorScheme}-${width}.png`);
		await app.press("id:goto-review");
		await app.waitFor("id:answers");
		await app.wait(400);
		await app.screenshot(`output/interview-parts-answers-${colorScheme}-${width}.png`);
	}
});

test("question help on a planning round in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("../QuestionHelpFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:interview");
		await app.keyboard.press("m");
		await app.wait(400);
		await app.screenshot(`output/question-help-parts-${colorScheme}-${width}.png`);
	}
});
