import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1000, height: 900 } as const;
test("failed chat retries in place while final archive stays unavailable", async () => {
	const app = await open("./RecoveryFixture.tsx", desktop);
	await app.waitFor("id:chat-retry");
	expect(app.shows("Sends: 0 / Checks: 0")).toBe(true);
	await app.press("id:chat-retry");
	await app.waitFor("Working.");
	expect(app.shows("Sends: 1 / Checks: 0")).toBe(true);
	expect(app.shows("id:chat-retry")).toBe(false);
	expect(app.shows("id:chat-final-archive-wait")).toBe(true);
});
test("corrected follow-up keeps exact text and an uncertain send offers only Check", async () => {
	const app = await open("./RecoveryFixture.tsx", desktop);
	await app.waitFor("id:chat-retry");
	await app.press("Lose next answer");
	await app.press("id:chat-correct");
	await app.type("id:chat-recovery-note", "Keep the original files. Fix only CSV export.");
	await app.press("id:chat-recovery-send");
	await app.waitFor("id:chat-recovery-check");
	expect(app.shows("Sends: 1 / Checks: 0")).toBe(true);
	expect(app.shows("id:chat-retry")).toBe(false);
	await app.press("id:chat-recovery-check");
	await app.waitFor("Working.");
	expect(app.shows("Sends: 1 / Checks: 1")).toBe(true);
	expect(app.shows("Sent: [Keep the original files. Fix only CSV export.]")).toBe(true);
});

test("saved correction restores without sending; startup and archived states do not offer correction", async () => {
	const app = await open("./RecoveryFixture.tsx", desktop);
	await app.waitFor("id:chat-correct");
	await app.press("id:chat-correct");
	await app.type("id:chat-recovery-note", "Keep this correction 🐦");
	await app.press("Save and reopen");
	await app.waitFor("id:chat-recovery-note");
	expect(app.value("id:chat-recovery-note")).toBe("Keep this correction 🐦");
	expect(app.shows("Sends: 0 / Checks: 0")).toBe(true);
	await app.press("Startup failure");
	expect(app.shows("id:chat-correct")).toBe(false);
	await app.press("Archive view");
	expect(app.shows("id:chat-retry")).toBe(false);
	expect(app.shows("Archived. This view is read-only.")).toBe(true);
});

test("loading and failed earlier-history reads keep every recovery and custody safeguard", async () => {
	let reads = 0;
	const app = await open("./fixtures/recovery/Projection.tsx", {
		...desktop,
		host: {
			handlers: {
				"day.chat.read": () => {
					reads++;
					if (reads > 1) return { version: 1, error: "offline" };
					return {
						version: 1,
						value: {
							snapshot: {
								sessionId: "chat-1",
								title: "Saved chat",
								state: "failed",
								stateReason: "",
								rows: [],
								more: true,
								reading: false,
								reason: "",
								archived: true,
								restartOnly: true,
								workspaceKept: true,
								pendingRecovery: { state: "unknown", operationId: "pending-1" },
							},
						},
					};
				},
			},
		},
	});
	const metadata = "Custody: true / Archived: true / Startup: true / Pending: pending-1";
	await app.waitFor(metadata);
	await app.press("Read earlier");
	expect(app.shows(metadata)).toBe(true);
	await app.waitFor("Pilot could not read this chat. Nothing was sent.");
	expect(app.shows(`Loading: ${metadata}`)).toBe(true);
	expect(app.shows(metadata)).toBe(true);
});

test("an oversized correction names the byte limit and keeps the complete draft", async () => {
	const app = await open("./RecoveryFixture.tsx", desktop);
	await app.waitFor("id:chat-correct");
	await app.press("id:chat-correct");
	const text = "🐦".repeat(3001);
	await app.type("id:chat-recovery-note", text);
	await app.waitFor(
		"This follow-up is 12004 bytes. The limit is 12000; shorten it before sending. Your draft is kept.",
	);
	expect(app.enabled("id:chat-recovery-send")).toBe(false);
	expect(app.value("id:chat-recovery-note")).toBe(text);
});

test("a setup failure keeps files visible without offering unavailable recovery submissions", async () => {
	const app = await open("./RecoveryFixture.tsx", desktop);
	await app.waitFor("id:chat-retry");
	await app.press("Setup failed");
	await app.waitFor("Repair setup before retrying. Existing files are kept.");
	expect(app.shows("id:chat-retry")).toBe(false);
	expect(app.shows("id:chat-correct")).toBe(false);
	expect(app.shows("id:chat-final-archive-wait")).toBe(true);
});

test("reopening an uncertain correction keeps Check and clears only its unchanged accepted draft", async () => {
	const app = await open("./RecoveryFixture.tsx", desktop);
	await app.waitFor("id:chat-correct");
	await app.press("Lose next answer");
	await app.press("id:chat-correct");
	await app.type("id:chat-recovery-note", "Keep the copy 🐦");
	await app.press("id:chat-recovery-send");
	await app.waitFor("id:chat-recovery-check");
	await app.press("Hide chat");
	await app.press("Reopen chat");
	await app.waitFor("id:chat-recovery-check");
	expect(app.shows("id:chat-retry")).toBe(false);
	await app.press("id:chat-recovery-check");
	await app.waitFor("Working.");
	await app.press("Fail again");
	await app.press("id:chat-correct");
	expect(app.value("id:chat-recovery-note")).toBe("");
	expect(app.shows("Sends: 1 / Checks: 1")).toBe(true);
});
