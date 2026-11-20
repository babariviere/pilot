// Thread, preference and result writes whose reply was lost, over the real
// TSX adapters with scripted root replies: Pilot looks each up by itself,
// never sends it again, offers Check only after its tries, and starts over
// when the service is back after a failed read.
import { expect, open, test } from "nsh/test";

const subject = { kind: "chat", projectId: "p", sessionId: "s" };
const threadOp = (state: string) => ({ operationId: "t1", purpose: "thread-send", topicId: "x", text: "Hi", state });
const preferenceOp = (state: string) => ({ operationId: "p1", state, expectedRevision: 3 });
const resultOp = (state: string) => ({ operationId: "d1", subject, action: "done", note: "", state });

type Script = { settleOn?: number; failReads?: boolean };

async function openLookups(script: Script) {
	const checks = { thread: 0, preference: 0, result: 0, sends: 0 };
	let reads = 0;
	const state = (n: number) => (script.settleOn !== undefined && n >= script.settleOn ? "accepted" : "unknown");
	const app = await open("../../ConnectedLookupsFixture.tsx", {
		platform: "macos",
		width: 600,
		height: 400,
		clock: {},
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, request: { args: { projectId?: string; operationId?: string } }) => {
					const ok = (value: Record<string, unknown>) => ({ version: 1, value: { snapshot: null, ...value } });
					switch (name) {
						case "day.threads.read":
							reads++;
							if (script.failReads && reads === 2) return { version: 1, error: "offline" };
							return ok({ operations: [threadOp(state(checks.thread))] });
						case "day.threads.check":
							checks.thread++;
							return ok({ operations: [threadOp(state(checks.thread))] });
						case "day.preferences.read":
							expect(request.args).toEqual({ projectId: "p" });
							if (script.failReads && reads === 2) return { version: 1, error: "offline" };
							return ok({ projectId: "p", operations: [preferenceOp(state(checks.preference))] });
						case "day.preferences.check":
							expect(request.args).toEqual({ projectId: "p", operationId: "p1" });
							checks.preference++;
							return ok({ projectId: "p", operations: [preferenceOp(state(checks.preference))] });
						case "day.delivery.saved":
							if (script.failReads && reads === 2) return { version: 1, error: "offline" };
							return ok({ operations: [resultOp(state(checks.result))] });
						case "day.delivery.check":
							checks.result++;
							return ok({ operations: [resultOp(state(checks.result))] });
						case "day.threads.write":
						case "day.preferences.save":
						case "day.delivery.done":
							checks.sends++;
							return { version: 1, error: "invalid" };
						default:
							return { version: 1, error: "unavailable" };
					}
				},
			},
		},
	});
	return { app, checks };
}

test("lost thread, preference and result writes are looked up by themselves and settle without a click", async () => {
	const { app, checks } = await openLookups({ settleOn: 2 });
	await app.waitFor("text:thread: checking");
	await app.waitFor("text:preference: checking");
	await app.waitFor("text:result: checking");
	await app.wait(3_000);
	await app.waitFor("text:thread: accepted");
	await app.waitFor("text:preference: none");
	await app.waitFor("text:result: none");
	expect(checks).toEqual({ thread: 2, preference: 2, result: 2, sends: 0 });
});

test("after their automatic checks they wait for Check, and start over once the service is back", async () => {
	const { app, checks } = await openLookups({ failReads: true });
	await app.wait(120_000);
	await app.waitFor("text:thread: unknown");
	await app.waitFor("text:preference: unknown");
	await app.waitFor("text:result: unknown");
	expect(checks).toEqual({ thread: 6, preference: 6, result: 6, sends: 0 });
	// One read fails, the next one works: the service is back.
	await app.press("role:button[Read again]");
	await app.press("role:button[Read again]");
	await app.waitFor("text:thread: checking");
	await app.waitFor("text:preference: checking");
	await app.waitFor("text:result: checking");
	await app.waitUntil(() => checks.thread === 7 && checks.preference === 7 && checks.result === 7);
	expect(checks.sends).toBe(0);
});
