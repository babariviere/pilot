import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 900, height: 700 } as const;

test("tool steps expand without sending; a refresh keeps the focused draft", async () => {
	const app = await open("./ChatReplyFixture.tsx", desktop);
	await app.waitFor("id:chat-message");
	expect(app.enabled("id:chat-send")).toBe(false);
	expect(app.shows("Ran a command")).toBe(false);
	await app.press("id:chat-steps-2");
	await app.waitFor("Ran a command");
	await app.type("id:chat-message", "Keep the header");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("An update from the service.");
	await app.keyboard.press("x");
	expect(app.value("id:chat-message")).toBe("Keep the headerx");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Keep the headerx");
	expect(app.value("id:chat-message")).toBe("");
	expect(app.count("text:Keep the headerx")).toBe(1);
});

test("an unconfirmed send is looked up without sending the draft again", async () => {
	const app = await open("./ChatReplyFixture.tsx", desktop);
	await app.waitFor("id:chat-message");
	await app.keyboard.press("mod+shift+l");
	await app.type("id:chat-message", "My first draft");
	await app.press("id:chat-send");
	await app.waitFor("id:chat-message-check");
	expect(app.value("id:chat-message")).toBe("My first draft");
	await app.clear("id:chat-message");
	await app.type("id:chat-message", "A later draft");
	await app.keyboard.press("mod+enter");
	expect(app.shows("id:chat-6")).toBe(false);
	await app.keyboard.press("mod+shift+l");
	await app.waitFor("id:chat-6 >> text:My first draft");
	expect(app.count("text:My first draft")).toBe(1);
	expect(app.value("id:chat-message")).toBe("A later draft");
});
