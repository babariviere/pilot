import { expect, open, test } from "nsh/test";

test("uncertain creation stays checkable while another draft is independent", async () => {
	const app = await open("./NewRecoveryFixture.tsx", { platform: "macos", width: 1100, height: 1400 });
	await app.press("label:Project for a new chat");
	await app.press("text:pilot");
	await app.waitFor("role:button[Create another]");
	expect(app.shows("id:planning-off")).toBe(false);
	await app.press("role:button[Check status]");
	await app.waitFor("Checked original-receipt. No creation sent.");
	expect(app.value("id:goal")).toBe("Export a chat");
	await app.press("role:button[Create another]");
	await app.waitFor("Separate request chosen. Original receipt kept.");
	expect(app.shows("role:button[Check status]")).toBe(true);
	await app.type("id:goal", "Different work");
	await app.press("role:button[Plan a mission]");
	await app.waitFor("Different goal can be planned independently.");
});
