// Real TSX adapter and screen, scripted bridge replies. No live service or providers.
import { expect, open, test } from "nsh/test";
import type { FeedbackItem, SendIntent } from "./feedbackFeed";

test("connected sends carry screenshots and reconcile only their item while unrelated feedback continues", async () => {
	const image = { uploadId: "00000000-0000-4000-8000-000000000001", sha256: "a".repeat(64), bytes: 70 };
	const sent: SendIntent[] = [];
	const saved: FeedbackItem[] = [];
	let unknown: SendIntent | null = null;
	let checks = 0;
	const snapshot = () => ({ version: 1, items: saved, more: false, before: null });
	const app = await open("./FeedbackBridgeFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 1600,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (_name: string, envelope: { args: unknown }) => {
					const args = envelope.args;
					if (_name === "day.projects.read") return { version: 1, value: { snapshot: { projects: [] } } };
					if (_name === "day.feedback.image") {
						const request = args as { uploadId?: string; data?: string };
						return { version: 1, value: request.data ? { image } : { uploadId: image.uploadId } };
					}
					let outcome: unknown = null;
					if (_name === "day.feedback.send") {
						const intent = args as SendIntent;
						sent.push(intent);
						if (sent.length === 1) {
							unknown = intent;
							outcome = { operationId: "op-1", state: "unknown" };
						} else {
							const item = {
								...intent,
								origin: null,
								id: "f2",
								operationId: "op-2",
								sequence: 2,
								recordedAt: 1,
								work: [],
							};
							saved.unshift(item);
							outcome = { operationId: "op-2", state: "accepted", receipt: { result: item } };
						}
					}
					if (_name === "day.feedback.check") {
						checks++;
						expect(args).toEqual({ operationId: "op-1" });
						const item = {
							...unknown!,
							origin: null,
							id: "f1",
							operationId: "op-1",
							sequence: 1,
							recordedAt: 1,
							work: [],
						};
						saved.push(item);
						unknown = null;
						outcome = { operationId: "op-1", state: "accepted", receipt: { result: item } };
					}
					return {
						version: 1,
						value: {
							snapshot: snapshot(),
							outcome,
							operations: unknown ? [{ ...unknown, operationId: "op-1" }] : [],
						},
					};
				},
			},
		},
	});
	await app.waitFor("id:feedback-text");
	await app.type("id:feedback-text", "First screenshot report");
	await app.paste("id:feedback-text", { files: ["../macos/Resources/LegacyApp/HomeSky.png"] });
	await app.waitFor("Image 1 attached");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	expect(sent).toEqual([{ text: "First screenshot report", origin: null, attachments: [image] }]);
	expect(app.enabled("id:feedback-send")).toBe(false);
	await app.type("id:feedback-text", " with more detail");
	await app.press("id:feedback-another");
	await app.type("id:feedback-text", "Unrelated feedback");
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(sent.length).toBe(2);
	expect(app.shows("id:feedback-unknown")).toBe(true);
	await app.type("id:feedback-text", "Keep this third draft");
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.value("id:feedback-text")).toBe("Keep this third draft");
	expect(app.shows("id:feedback-unknown")).toBe(false);
	expect(sent.length).toBe(2);
	expect(checks).toBe(1);
	await app.press("id:feedback-resume");
	expect(app.value("id:feedback-text")).toBe("First screenshot report with more detail");
	expect(app.shows("Keep this third draft")).toBe(true);
	expect(app.shows("Image 1 attached")).toBe(true);
});
