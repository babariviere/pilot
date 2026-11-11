/** Real daemon, SessionManager and forked kernel, temporary home and faux provider only. */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type KernelSpec, PLANNING_PROFILE, workerEntry } from "@pilot/kernel";
import type { DurableOperation, InterviewWrite } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager, Worker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const exec = promisify(execFile);
export async function planningWorkerFixture(
	t?: TestContext,
	options: { followup?: boolean; publishedPlan?: boolean } = {},
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "planning-worker-")));
	const home = join(root, "home"),
		repo = join(root, "repo"),
		agent = join(root, "agent");
	await Promise.all([mkdir(home), mkdir(repo), mkdir(agent)]);
	await exec("/usr/bin/git", ["init", "-b", "main", repo]);
	await exec("/usr/bin/git", ["-C", repo, "config", "user.name", "Fixture"]);
	await exec("/usr/bin/git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
	await writeFile(join(repo, "README.md"), "Isolated planning fixture\n");
	await exec("/usr/bin/git", ["-C", repo, "add", "."]);
	await exec("/usr/bin/git", ["-C", repo, "commit", "-m", "Fixture"]);
	await exec("/usr/bin/git", ["-C", repo, "remote", "add", "origin", repo]);
	const requests = join(root, "requests.jsonl"),
		extension = join(agent, "offline.ts");
	const questions = ["outcome", "acceptance"].map((id) => ({
		id,
		section: id,
		prompt: `Choose ${id}`,
		options: [{ id: "yes", meaning: `Use ${id}` }],
		recommendedOptionId: "yes",
	}));
	const code = `function decode(x) { if(typeof x === "string") { try { return decode(JSON.parse(x)); } catch { return x; } } if(x?.content) return decode(x.content.map(p=>p.text??"").join("")); return x; }
const source = await tools.read({path:${JSON.stringify(fileURLToPath(new URL("../../kernel/skills/mission-interview/upstream/grill-with-docs/SKILL.md", import.meta.url)))}});
const view = decode(await tools.mission_plan({action:"read"}));
return await tools.mission_plan({action:"questions",request:{purpose:"interview-questions",expected:{fence:view.interview.fence,revision:view.interview.revision},questions:${JSON.stringify(questions)}}});`;
	const followupCode = code.replace(
		JSON.stringify(questions),
		JSON.stringify(
			questions.map((q) => ({
				...q,
				id: `followup-${q.id}`,
				prompt: `New clarification about ${q.id}`,
				options: [{ id: "new", meaning: "Clarify this specific gap" }],
				recommendedOptionId: "new",
			})),
		),
	);
	const proposal = {
		purpose: "plan-propose",
		expectedRevision: 1,
		spec: {
			problem: "Check importer",
			solution: "One offline task",
			stories: [{ id: "one", text: "Receive a report" }],
			implementation: ["Existing worker"],
			testing: ["Offline report"],
			exclusions: ["No live effects"],
		},
		slices: [
			{
				id: "one",
				title: "Check importer",
				outcome: "Report offline results",
				acceptance: ["Saved report"],
				storyIds: ["one"],
				dependsOn: [],
				owners: ["sol-backend"],
			},
		],
	};
	const proposalCode = `await tools.mission_plan({action:"write",request:{purpose:"plan-map",expectedRevision:0,destination:"Importer",sources:[],questions:[],fog:[]}}); await tools.mission_plan({action:"write",request:${JSON.stringify(proposal)}}); return await tools.mission_plan({action:"write",request:{purpose:"plan-review",expectedRevision:2}});`;
	const publishCode = `return await tools.mission_plan({action:"write",request:{purpose:"plan-publish",expectedRevision:3}});`;
	const reportCode = `function decode(x) { if(typeof x === "string") { try { return decode(JSON.parse(x)); } catch { return x; } } if(x?.content) return decode(x.content.map(p=>p.text??"").join("")); return x; }
const m=decode(await tools.mission({action:"get"}));
const tasks=decode(await tools.mission({action:"tasks",mine:true}));
const task=(tasks.tasks??tasks)[0];
const source=decode(await tools.mission({action:"report",taskId:String(task.number)}));
return await tools.mission({action:"report",report:{version:1,reportId:"offline-result",taskId:source.taskId,source:source.source,expectedPreviousId:source.expectedPreviousId,movement:"moving",summary:"Offline background worker reported",nextStep:"User checks results",evidence:["Faux provider, no network"]}});`;
	await writeFile(
		extension,
		`
import { appendFileSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default pi => {
 const faux=fauxProvider(); let n=0;
 const respond = (text) => async transcript => { appendFileSync(${JSON.stringify(requests)},JSON.stringify({request:++n})+'\\n'); if(!${options.publishedPlan} && n===1 && JSON.stringify(transcript.messages).includes('Continue planning from this exact submitted interview')) return fauxAssistantMessage('Recovered planning continuation, no build.'); if(${options.publishedPlan} && n===1 && JSON.stringify(transcript.messages).includes('Work on mission task')) return fauxAssistantMessage({type:'toolCall',id:'background-report',name:'codemode',arguments:{code:${JSON.stringify(reportCode)}}},{stopReason:'toolUse'}); if(${options.publishedPlan} && n>1 && JSON.stringify(transcript.messages).includes('Work on mission task')) return fauxAssistantMessage('Offline background task report saved.'); return text; };
 faux.setResponses([
  respond(fauxAssistantMessage({type:'toolCall',id:'saved-round',name:'codemode',arguments:{code:${JSON.stringify(options.publishedPlan ? proposalCode : code)}}},{stopReason:'toolUse'})),
  ${options.publishedPlan ? `respond(fauxAssistantMessage({type:'toolCall',id:'publish-plan',name:'codemode',arguments:{code:${JSON.stringify(publishCode)}}},{stopReason:'toolUse'})),` : ""}
  ${options.followup ? `respond(fauxAssistantMessage({type:'toolCall',id:'followup-round',name:'codemode',arguments:{code:${JSON.stringify(followupCode)}}},{stopReason:'toolUse'})),` : ""}
  respond(fauxAssistantMessage('Planning continuation completed, no build started.'))
 ]);
	pi.registerProvider(faux.provider);
};`,
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			enabledModels: ["faux/faux-1"],
			extensions: [extension],
			defaultProvider: "faux",
			defaultModel: "faux-1",
			defaultTools: ["+codemode"],
			codemode: { mode: "only" },
		}),
	);
	// Register faux only in this process's real catalog. The forked kernel loads its normal extension.
	const createRuntime = ModelRuntime.create.bind(ModelRuntime);
	const catalogRuntime = mock.method(
		ModelRuntime,
		"create",
		async (...args: Parameters<typeof ModelRuntime.create>) => {
			const runtime = await createRuntime(...args);
			runtime.registerNativeProvider(fauxProvider().provider);
			await runtime.setRuntimeApiKey("faux", "offline-fixture");
			return runtime;
		},
	);
	const offline = join(root, "offline.mjs");
	await writeFile(
		offline,
		"globalThis.fetch = async () => { throw new Error('Planning worker fixture forbids network'); };\n",
	);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: repo, workspace: "direct" });
	const hello = await daemonHello(home, {
		independentExecution: true,
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: true,
	});
	const host = { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId! };
	let store = new MissionStore(join(home, "missions.sqlite"));
	const specs: KernelSpec[] = [],
		kernels: Worker[] = [];
	const children: ChildProcess[] = [];
	const changes = new EventEmitter();
	let logs = "";
	const newSessions = () =>
		new SessionManager(
			home,
			projects,
			agent,
			{
				worker: (spec, onPacket, onExit) => {
					specs.push(spec);
					const child = fork(fileURLToPath(workerEntry), [], {
						cwd: spec.cwd,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
						env: {
							PATH: process.env.PATH,
							HOME: root,
							XDG_CONFIG_HOME: join(root, "config"),
							TMPDIR: root,
							PI_OFFLINE: "1",
							PI_CODING_AGENT_DIR: agent,
							NODE_OPTIONS: `--import=${offline}`,
						},
					});
					children.push(child);
					child.stdout!.on("data", (b) => {
						logs = (logs + b).slice(-32768);
					});
					child.stderr!.on("data", (b) => {
						logs = (logs + b).slice(-32768);
					});
					const worker = new Worker(
						spec,
						(packet) => {
							if (options.publishedPlan && JSON.stringify(packet).includes("tool_execution_end"))
								logs = (logs + JSON.stringify(packet)).slice(-32768);
							onPacket(packet);
							changes.emit("packet");
						},
						onExit,
						undefined,
						{ child, startupTimeoutMs: 15000 },
					);
					kernels.push(worker);
					return worker;
				},
			},
			{},
			{ diagnosticHost: host },
		);
	let sessions = newSessions();
	let service = new MissionService(store, sessions, projects);
	service.controls.setScheduleDrain(async () => {}); // This fixture owns no schedules.
	let native: GitHubSetupService,
		terminals: TerminalManager,
		server: ReturnType<typeof createDaemonServer>,
		base = "",
		capability = "";
	const start = async () => {
		native = new GitHubSetupService(home, { ...host, hostId: "local" }, { userHome: root, env: {} });
		await native.status();
		capability = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token;
		terminals = new TerminalManager();
		const args: Parameters<typeof createDaemonServer> = [
			{ home, host: "127.0.0.1", port: 0 },
			sessions,
			projects,
			new ModelCatalog(agent),
			terminals,
			{ service, store },
		];
		args[12] = hello;
		args[17] = native;
		server = createDaemonServer(...args);
		await server.runtimeReady;
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	};
	await start();
	const profileRead = await fetch(`${base}/api/projects/${project.id}/planning-profile`, {
		headers: { "x-pilot-github-capability": capability },
	});
	assert.equal(profileRead.status, 200);
	const profile = await profileRead.json();
	const operation = (targetId: string, request: { purpose: string }, bindingId: string): DurableOperation => {
		const payload = canonicalJSON(request);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...host, hostId: "local" },
			destination: host,
			targetId,
			kind: request.purpose,
			payload,
			payloadHash: payloadHash(payload),
			bindingId,
			bindingGeneration: 1,
		};
	};
	const enrollment = operation(
		randomUUID(),
		{
			purpose: "planning-enroll",
			projectId: project.id,
			ownerSessionId: randomUUID(),
			title: "Planning fixture",
			goal: "Clarify the importer",
			model: "faux/faux-1",
			profile: PLANNING_PROFILE,
			configurationDigest: profile.configurationDigest,
		} as { purpose: string },
		profile.configurationDigest,
	);
	const post = async (op: DurableOperation, receipt = false) => {
		const response = await fetch(`${base}/api/operations${receipt ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
			body: JSON.stringify(op),
		});
		const body = await response.json();
		assert.equal(response.status, 200, JSON.stringify(body) + logs);
		return body;
	};
	const read = async (missionId: string) => {
		const r = await fetch(`${base}/api/projects/${project.id}/missions/${missionId}/planning`, {
			headers: { "x-pilot-github-capability": capability },
		});
		assert.equal(r.status, 200, await r.clone().text());
		return r.json();
	};
	let closed = false;
	const stop = async () => {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		await server.closePlanning();
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await store.durable();
		store.close();
	};
	const close = async () => {
		if (closed) return;
		closed = true;
		await stop();
		catalogRuntime.mock.restore();
		await exec("/bin/chmod", ["-R", "u+w", root]);
		await rm(root, { recursive: true, force: true });
	};
	t?.after(close);
	return {
		home,
		root,
		get base() {
			return base;
		},
		hello,
		get capability() {
			return capability;
		},
		close,
		get store() {
			return store;
		},
		get sessions() {
			return sessions;
		},
		get service() {
			return service;
		},
		get server() {
			return server;
		},
		specs,
		kernels,
		project,
		enrollment,
		operation,
		post,
		read,
		async restart() {
			await stop();
			store = new MissionStore(join(home, "missions.sqlite"));
			sessions = newSessions();
			service = new MissionService(store, sessions, projects);
			service.controls.setScheduleDrain(async () => {});
			await sessions.load();
			await start();
		},
		projectUpdate: () => projects.update(project.id, { model: "faux/changed" }),
		async crashWorker(index = 0) {
			const child = children[index]!;
			const exited = once(child, "exit");
			assert.equal(child.kill("SIGKILL"), true);
			await exited;
		},
		logs: () => logs,
		async requestCount() {
			return (await readFile(requests, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
		},
		async human(missionId: string, request: InterviewWrite) {
			const view = await read(missionId);
			const op = operation(missionId, request, view.contextDigest);
			return { op, receipt: await post(op) };
		},
		async changed(check: () => boolean): Promise<void> {
			if (check()) return;
			await new Promise<void>((resolve, reject) => {
				const off = () => {
					offSession();
					offStore();
					changes.off("packet", changed);
				};
				const timeout = setTimeout(() => {
					off();
					reject(
						new Error(
							`Fixture state did not settle: ${logs} ${JSON.stringify(sessions.list().map((s) => ({ id: s.id, state: s.state, outcome: s.outcome, reason: s.outcomeReason })))}`,
						),
					);
				}, 15000);
				const changed = () => {
					if (check()) {
						clearTimeout(timeout);
						off();
						resolve();
					}
				};
				const offSession = sessions.onChange(changed),
					offStore = store.onChange(changed);
				changes.on("packet", changed);
				changed();
			});
		},
	};
}
