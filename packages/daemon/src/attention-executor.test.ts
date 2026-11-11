import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistanceRecord, AssistanceRequest, AttentionResult } from "@pilot/protocol";
import { ReadOnlyAttentionExecutor, type AttentionExecutionConfiguration } from "./attention-executor.ts";
import { nativeAttentionFixture } from "./native-attention.fixture.ts";
import { MissionControls } from "./mission-controls.ts";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function value<T>(result: AttentionResult<T>): T {
	assert.ok(result.ok, JSON.stringify(result));
	return result.value;
}
function error(result: AttentionResult<unknown>, code: string) {
	assert.equal(result.ok, false, JSON.stringify(result));
	if (!result.ok) assert.equal(result.error.code, code);
}
async function fixture(t: TestContext) {
	const f = await nativeAttentionFixture();
	const releases: Array<() => void> = [];
	const runtime = await ModelRuntime.create({
		authPath: join(f.home, "isolated-auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	let configuration: AttentionExecutionConfiguration | undefined = {
		revision: "fixture-permission-and-budget-v1",
		provider: "faux",
		model: faux.getModel().id,
		maxOutputTokens: 256,
		durationMs: 30000,
	};
	const state = {
		reserved: [] as AssistanceRequest[],
		settled: 0,
		allowed: true,
		beforeReserve: async () => {},
		beforeSettle: async () => {},
	};
	const executor = new ReadOnlyAttentionExecutor(runtime, {
		configuration: (projectId) => {
			assert.equal(projectId, f.project.id);
			return configuration;
		},
		reserve: async (req, config) => {
			assert.deepEqual(config, configuration);
			assert.equal(
				f.store.attention.assistance(req.requestId)?.state,
				"entered",
				"durable entry precedes budget admission",
			);
			state.reserved.push(req);
			await state.beforeReserve();
			return {
				id: `charge-${req.requestId}`,
				assertCurrent: () => {
					if (!state.allowed) throw new Error("Budget/permission revoked");
				},
				settle: async () => {
					state.settled++;
					await state.beforeSettle();
				},
			};
		},
	});
	const adapter = f.adapter(executor);
	const request = async (kind: AssistanceRequest["kind"] = "simpler") => ({
		requestId: randomUUID(),
		scope: value(
			(await adapter.dispatch({ ...f.envelope(), kind: "read" })) as AttentionResult<
				import("@pilot/protocol").NativeAttentionRead
			>,
		).questions[0]!.scope,
		kind,
		...(kind === "question" ? { question: "Why this package?" } : {}),
	});
	const send = (req: AssistanceRequest, lookup = false) =>
		adapter.dispatch({ ...f.envelope(), kind: "help", request: req }, lookup) as Promise<
			AttentionResult<AssistanceRecord>
		>;
	t.after(async () => {
		for (const release of releases) release();
		await adapter.close();
		await f.close();
	});
	return {
		f,
		runtime,
		faux,
		executor,
		adapter,
		state,
		request,
		send,
		releases,
		get config() {
			return configuration;
		},
		set config(v: AttentionExecutionConfiguration | undefined) {
			configuration = v;
		},
	};
}

test("native help requires a qualified configured capability, not a callback or policy fallback", async (t) => {
	const x = await fixture(t);
	assert.equal(
		value(
			(await x.adapter.dispatch({ ...x.f.envelope(), kind: "read" })) as AttentionResult<{
				capabilities: { help: number };
			}>,
		).capabilities.help,
		1,
	);
	x.config = undefined;
	assert.equal(x.executor.available(x.f.project.id), false);
	error(await x.send(await x.request()), "unavailable");
	assert.equal(x.faux.state.callCount, 0);
	x.config = {
		revision: "other",
		provider: "openai-codex",
		model: "gpt-6.1-sol",
		maxOutputTokens: 256,
		durationMs: 1000,
	};
	assert.equal(x.executor.available(x.f.project.id), false);
	error(await x.send(await x.request()), "unavailable");
	assert.equal(x.state.reserved.length, 0);
	assert.equal((await x.f.read()).capabilities.help, "unavailable", "startup never installs the test executor");
});

test("real native admission plus SDK faux produces exact text-only commentary and saved provenance", async (t) => {
	const x = await fixture(t);
	for (const kind of ["simpler", "context", "question"] as const) {
		const req = await x.request(kind);
		x.faux.setResponses([
			async (context, options) => {
				for (const message of context.messages)
					if (message.role === "system") assert.equal(message.toolsAdded?.length ?? 0, 0);
				assert.equal(options?.maxTokens, 256);
				assert.equal(options?.maxRetries, 0);
				const text = JSON.stringify(context.messages);
				assert.match(text, /Which exact package/);
				assert.match(text, /reviewed bytes/);
				if (kind === "question") assert.match(text, /Why this package/);
				return fauxAssistantMessage(`Fixture ${kind} explanation`);
			},
		]);
		const record = value(await x.send(req));
		assert.equal(record.state, "ready");
		assert.equal(record.output?.kind, kind);
		assert.equal(record.producer?.provider, "faux");
		assert.equal(record.producer?.reservationId, `charge-${req.requestId}`);
		assert.deepEqual(value(await x.send(req, true)), record);
		error(await x.send(req), "conflict");
		if (record.output?.kind === "question") assert.equal(record.output.question, req.question);
	}
	assert.equal(x.faux.state.callCount, 3);
	assert.equal(x.state.settled, 3);
	assert.equal(x.f.sends, 0);
	assert.equal(x.f.question.id, 12);
	assert.equal(x.f.store.proposals(x.f.mission.id).length, 0);
});

test("authenticated HTTP help uses the same real admission and maintenance gate", async (t) => {
	const x = await fixture(t);
	await x.f.installExecutor(x.executor);
	assert.equal((await x.f.read()).capabilities.help, 1);
	const req = await x.request();
	x.faux.setResponses([fauxAssistantMessage("HTTP fixture explanation")]);
	const input = { ...x.f.envelope(), kind: "help", request: req };
	assert.equal((await x.f.post(input, false, "")).status, 403);
	assert.equal(x.faux.state.callCount, 0);
	const ready = value(await (await x.f.post(input)).json());
	assert.deepEqual(value(await (await x.f.post(input, true)).json()), ready);
	assert.equal(x.faux.state.callCount, 1);
	const release = x.executor.maintenance.freezeAdmissions();
	assert.equal((await x.f.read()).capabilities.help, "unavailable");
	error(await (await x.f.post(input, true)).json(), "stale");
	release();
});

test("tools, partial answers and unsupported visuals never become help or actions", async (t) => {
	const x = await fixture(t);
	for (const response of [
		fauxAssistantMessage(fauxToolCall("bash", { command: "touch forbidden" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("partial", { stopReason: "length" }),
		fauxAssistantMessage(""),
	]) {
		x.faux.setResponses([response]);
		const req = await x.request();
		error(await x.send(req), "unavailable");
		assert.equal(x.f.store.attention.assistance(req.requestId)?.output, undefined);
	}
	error(await x.send(await x.request("visual")), "unavailable");
	assert.equal(x.faux.state.callCount, 3);
	assert.equal(x.f.sends, 0);
});

test("stale question and revoked actor/configuration/Stop/Pause after budget I/O refuse before provider dispatch", async (t) => {
	for (const change of ["question", "actor", "configuration", "stop", "pause", "budget"] as const) {
		const x = await fixture(t);
		const req = await x.request();
		x.state.beforeReserve = async () => {
			if (change === "question") x.f.question = { ...x.f.question, id: 13 };
			if (change === "actor") x.f.store.leave(x.f.owner);
			if (change === "configuration") x.config = { ...x.config!, revision: "new-consent" };
			if (change === "stop") x.f.session = { ...x.f.session, outcome: "stopped" };
			if (change === "pause") x.f.session = { ...x.f.session, sleepPaused: true };
			if (change === "budget") x.state.allowed = false;
		};
		const r = await x.send(req);
		assert.equal(r.ok, false, change);
		assert.equal(x.faux.state.callCount, 0, change);
		assert.equal(x.state.settled, 1, change);
		assert.equal(x.f.store.attention.assistance(req.requestId)?.output, undefined);
	}
});

test("credential resolution cannot carry stale authority into concrete provider dispatch", async (t) => {
	const x = await fixture(t);
	const auth = x.runtime.getAuth.bind(x.runtime);
	t.mock.method(x.runtime, "getAuth", async (...args: Parameters<typeof x.runtime.getAuth>) => {
		const result = await auth(...args);
		x.f.session = { ...x.f.session, inputGeneration: 1 };
		return result;
	});
	error(await x.send(await x.request()), "stale");
	assert.equal(x.faux.state.callCount, 0);
});

test("late authority changes during accounting cannot publish a ready answer", async (t) => {
	const x = await fixture(t);
	x.faux.setResponses([fauxAssistantMessage("old commentary")]);
	const req = await x.request();
	x.state.beforeSettle = async () => {
		x.config = { ...x.config!, revision: "replaced" };
	};
	error(await x.send(req), "stale");
	assert.equal(x.f.store.attention.assistance(req.requestId)?.output, undefined);
});

test("configuration replacement invalidates saved help without erasing provenance", async (t) => {
	const x = await fixture(t);
	const req = await x.request();
	x.faux.setResponses([fauxAssistantMessage("historical explanation")]);
	const saved = value(await x.send(req));
	x.config = { ...x.config!, revision: "new-permission" };
	error(await x.send(req, true), "stale");
	assert.deepEqual(x.f.store.attention.assistance(req.requestId), saved);
	assert.equal(x.faux.state.callCount, 1);
});

test("mission Stop/Pause notifications cancel help; pause drain waits for actual provider exit", async (t) => {
	for (const action of ["stop", "pause"] as const) {
		const x = await fixture(t);
		const entered = deferred(),
			release = deferred();
		x.releases.push(() => release.resolve());
		let signal: AbortSignal | undefined;
		x.faux.setResponses([
			async (_context, options) => {
				signal = options?.signal;
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("old context");
			},
		]);
		const req = await x.request(),
			pending = x.send(req);
		await entered.promise;
		let pause: Promise<unknown> | undefined;
		if (action === "stop") x.f.store.controls.stop(x.f.mission.id);
		else {
			const controls = new MissionControls(x.f.store, {
				checkpointMission: async () => {
					await Promise.allSettled([x.executor.stop(req.requestId)]);
					return "paused";
				},
				resumeMission: async () => {
					throw new Error("Resume forbidden");
				},
			});
			controls.setScheduleDrain(async () => {});
			pause = controls.execute(x.f.mission.id, {
				version: 1,
				operationId: randomUUID(),
				home: x.f.host,
				projectId: x.f.project.id,
				coordinatorSessionId: x.f.owner,
				expectedRevision: 0,
				action: "pause",
			});
		}
		assert.equal(signal?.aborted, true, action);
		assert.equal(x.executor.maintenance.blockers().length, 1);
		if (pause) assert.equal(x.f.store.controls.current(x.f.mission.id).state, "pausing");
		release.resolve();
		assert.equal((await pending).ok, false);
		await pause;
		assert.equal(x.executor.maintenance.blockers().length, 0);
		assert.equal(x.f.store.attention.assistance(req.requestId)?.output, undefined);
	}
});

test("lost entry/reservation/settlement ACKs never replay, and exact durable help survives restart", async (t) => {
	const x = await fixture(t);
	const durable = x.f.store.attention.durable.bind(x.f.store.attention);
	const first = await x.request();
	x.f.store.attention.durable = async () => {
		await durable();
		throw new Error("entry ACK lost");
	};
	error(await x.send(first), "unknown");
	assert.equal(x.state.reserved.length, 0);
	x.f.store.attention.durable = durable;
	error(await x.send(first, true), "unknown");
	error(await x.send(first), "conflict");
	const second = await x.request();
	x.state.beforeReserve = async () => {
		throw new Error("charge ACK lost");
	};
	error(await x.send(second), "unknown");
	assert.equal(x.faux.state.callCount, 0);
	error(await x.send(second), "conflict");
	x.state.beforeReserve = async () => {};
	const third = await x.request();
	x.faux.setResponses([fauxAssistantMessage("not acknowledged")]);
	x.state.beforeSettle = async () => {
		throw new Error("usage ACK lost");
	};
	error(await x.send(third), "unknown");
	error(await x.send(third), "conflict");
	x.state.beforeSettle = async () => {};
	const fourth = await x.request();
	x.faux.setResponses([fauxAssistantMessage("saved exact answer")]);
	x.f.store.attention.durable = async () => {
		await durable();
		if (x.f.store.attention.assistance(fourth.requestId)?.state === "ready") throw new Error("result ACK lost");
	};
	error(await x.send(fourth), "unknown");
	x.f.store.attention.durable = durable;
	const saved = value(await x.send(fourth, true));
	await x.f.restart();
	const reopened = x.f.adapter(x.executor);
	const r = await reopened.dispatch({ ...x.f.envelope(), kind: "help", request: fourth }, true);
	assert.deepEqual(value(r), saved);
	assert.equal(x.faux.state.callCount, 2);
});

test("Stop and close retain actual provider/accounting lifetime, even when cancellation is ignored", async (t) => {
	const x = await fixture(t);
	const entered = deferred(),
		release = deferred();
	x.releases.push(() => release.resolve());
	let signal: AbortSignal | undefined;
	x.faux.setResponses([
		async (_context, options) => {
			signal = options?.signal;
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage("late text");
		},
	]);
	const req = await x.request();
	const pending = x.send(req);
	await entered.promise;
	const writing = deferred(),
		releaseWrite = deferred();
	x.releases.push(() => releaseWrite.resolve());
	const durable = x.f.store.attention.durable.bind(x.f.store.attention);
	x.f.store.attention.durable = async () => {
		await durable();
		if (x.f.store.attention.assistance(req.requestId)?.state !== "entered") {
			writing.resolve();
			await releaseWrite.promise;
		}
	};
	const stopped = x.executor.stop(req.requestId);
	assert.equal(signal?.aborted, true);
	assert.equal(x.executor.maintenance.blockers().length, 1);
	let closed = false;
	const closing = x.adapter.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(x.executor.available(x.f.project.id), false);
	release.resolve();
	await writing.promise;
	assert.equal(closed, false, "native close also joins the final attention durability ACK");
	releaseWrite.resolve();
	await Promise.allSettled([stopped, closing]);
	assert.equal((await pending).ok, false);
	assert.equal(x.executor.maintenance.blockers().length, 0);
	assert.equal(x.state.settled, 1);
	assert.equal(x.f.store.attention.assistance(req.requestId)?.output, undefined);
});
