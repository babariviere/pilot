// Real TSX adapter and screen, scripted bridge replies. No live service or providers.
import { expect, open, test } from "nsh/test";
import type { FeedbackItem, SendIntent } from "./feedbackFeed";

test("chosen investigation stays native-pinned through an uncertain save without a second UI start", async () => {
	const d = "d".repeat(64);
	let send: SendIntent | null = null;
	let item: FeedbackItem | null = null;
	let checks = 0,
		steps = 0;
	const app = await open("./FeedbackBridgeFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 1600,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, envelope: { args: unknown }) => {
					if (name === "day.projects.read")
						return {
							version: 1,
							value: {
								snapshot: { projects: [{ projectId: "original", name: "Original project", contextDigest: d }] },
							},
						};
					let outcome: unknown = null,
						investigationOutcome: unknown = null;
					if (name === "day.feedback.step") steps++;
					if (name === "day.feedback.send") {
						send = envelope.args as SendIntent;
						expect(send.investigation).toEqual({ projectId: "original", contextDigest: d });
						const payload = JSON.stringify({
							purpose: "feedback-work",
							action: "triage",
							feedbackId: "f",
							projectId: "original",
							contextDigest: d,
						});
						item = {
							id: "f",
							text: send.text,
							origin: null,
							operationId: "parent",
							recordedAt: 1,
							sequence: 1,
							work: [],
							investigation: {
								operation: {
									schemaVersion: 1,
									operationId: "child",
									producerId: "producer",
									sequence: 1,
									origin: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
									destination: { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" },
									kind: "feedback-work",
									targetId: "chat",
									payload,
									payloadHash: d,
									bindingId: d,
									bindingGeneration: 1,
								},
							},
						};
						outcome = { operationId: "parent", state: "unknown" };
					}
					if (name === "day.feedback.check") {
						checks++;
						expect(envelope.args).toEqual({ operationId: "parent" });
						item!.work = [
							{
								kind: "triage",
								sessionId: "chat",
								projectId: "original",
								operationId: "child",
								recordedAt: 1,
								chat: { title: "Triage", state: "working" },
							},
						];
						outcome = { operationId: "parent", state: "accepted", receipt: { result: item } };
						investigationOutcome = { operationId: "child", state: "accepted" };
					}
					return {
						version: 1,
						value: {
							snapshot: { version: 1, items: item ? [item] : [], more: false, before: null },
							operations:
								send && checks === 0
									? [{ operationId: "parent", state: "unknown", text: send.text, origin: null }]
									: [],
							outcome,
							investigationOutcome,
						},
					};
				},
			},
		},
	});
	await app.waitFor("id:feedback-text");
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Original project");
	await app.type("id:feedback-text", "Read this once");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	await app.press("id:feedback-project-none");
	await app.press("id:feedback-check");
	await app.waitFor("id:feedback-triage-f");
	expect(steps).toBe(0);
	expect(checks).toBe(1);
});

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
							const { investigation: _selected, ...content } = intent;
							const item = {
								...content,
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
						const { investigation: _selected, ...content } = unknown!;
						const item = {
							...content,
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
	await app.paste("id:feedback-text", { files: ["./macos/Resources/LegacyApp/HomeSky.png"] });
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
