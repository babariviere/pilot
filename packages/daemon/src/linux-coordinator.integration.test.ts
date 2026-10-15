import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { type KernelSpec, workerEntry } from "@pilot/kernel";
import { ANTHROPIC_AUTH_PATH, CHILD_PROFILE_PATH, CHILD_WORKER_ENTRY } from "@pilot/kernel/bundled-extensions";
import { CredentialBroker } from "./credential-broker.ts";
import {
	forkLinuxCoordinator,
	probeLinuxCoordinatorIsolation,
	validateCoordinatorWrites,
} from "./linux-coordinator.ts";
import { forkMainViewWorker } from "./main-view.ts";
import { Worker } from "./sessions.ts";

test("private write roots reject symlink roots, protected overlaps, hardlinks, broad roots and special files", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-isolation-paths-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const scratch = join(root, "scratch");
	await mkdir(source, { mode: 0o700 });
	await mkdir(scratch, { mode: 0o700 });
	await writeFile(join(source, "file"), "source");
	assert.deepEqual(await validateCoordinatorWrites([scratch], [source]), [scratch]);
	await assert.rejects(validateCoordinatorWrites([root], [source]), /overlaps/);
	await assert.rejects(validateCoordinatorWrites([source], [source]), /overlaps/);
	await assert.rejects(validateCoordinatorWrites([scratch, scratch], [source]), /overlap/);
	const alias = join(root, "alias");
	await symlink(scratch, alias);
	await assert.rejects(validateCoordinatorWrites([alias], [source]), /canonical/);
	await link(join(source, "file"), join(scratch, "hardlink"));
	await assert.rejects(validateCoordinatorWrites([scratch], [source]), /hardlink/);
	await rm(join(scratch, "hardlink"));
	execFileSync("mkfifo", [join(scratch, "fifo")]);
	await assert.rejects(validateCoordinatorWrites([scratch], [source]), /special file/);
	await rm(join(scratch, "fifo"));
	await chmod(scratch, 0o770);
	await assert.rejects(validateCoordinatorWrites([scratch], [source]), /private/);
	await chmod(scratch, 0o700);
	// Symlinks inside private scratch are safe: following one still uses the readonly target mount.
	await symlink(source, join(scratch, "source-alias"));
	assert.deepEqual(await validateCoordinatorWrites([scratch], [source]), [scratch]);
	await assert.rejects(validateCoordinatorWrites(["/tmp"], [source]), /private|broad/);
});

test("coordinator Worker cannot consume an unrestricted warm process", () => {
	const spec = { pilot: { coordinatorView: { scratch: "/tmp", protectedPaths: [] } } };
	let taken = false;
	assert.throws(
		() =>
			new Worker(
				spec as never,
				() => {},
				() => {},
				{
					take() {
						taken = true;
					},
				} as never,
			),
		/fresh, validated/,
	);
	assert.equal(taken, false);
});

test("real Linux boundary protects alternate paths and descendants while preserving IPC and private state", {
	skip: process.platform !== "linux",
	timeout: 60_000,
}, async (t) => {
	const capability = await probeLinuxCoordinatorIsolation();
	if (!capability.available) {
		assert.notEqual(process.env.PILOT_REQUIRE_LINUX_ISOLATION, "1", capability.detail);
		t.skip(capability.detail);
		return;
	}
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-linux-boundary-")));
	let broker: CredentialBroker;
	t.after(async () => {
		await broker?.close();
		await rm(root, { recursive: true, force: true });
	});
	const source = join(root, "source with spaces");
	const scratch = join(root, "session", "scratch");
	const storageDir = join(root, "session", "durable");
	const agentDir = join(root, "agent");
	for (const path of [source, scratch, agentDir]) await mkdir(path, { recursive: true, mode: 0o700 });
	const file = join(source, "file");
	await writeFile(file, "protected", { mode: 0o600 });
	await writeFile(join(agentDir, "settings.json"), "{}", { mode: 0o600 });
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({ fixture: { type: "oauth", access: "0", refresh: "r0", expires: 0 } }),
		{ mode: 0o600 },
	);
	broker = new CredentialBroker(agentDir);
	await broker.start();
	const credentials = broker.grant();
	const state = { storageDir, agentDir, credentials };
	const capabilityFile = join(root, "fixture-capability.json");
	await writeFile(capabilityFile, JSON.stringify(credentials), { mode: 0o600 });
	const outside = join(root, "outside");
	await writeFile(outside, "host");
	const alias = join(root, "source-alias");
	await symlink(source, alias);
	await symlink(file, join(scratch, "source-link"));
	await symlink(outside, join(source, "external-link"));
	const entry = join(root, "child.cjs");
	const checks = `
const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const file=${JSON.stringify(file)}, scratch=${JSON.stringify(scratch)}, agent=${JSON.stringify(agentDir)};
const denied=fn=>assert.throws(fn, e=>['EROFS','EPERM','EACCES','EXDEV'].includes(e.code));
for(const path of [file,${JSON.stringify(join(alias, "file"))},${JSON.stringify(join(scratch, "source-link"))},
 '/proc/self/root'+file,${JSON.stringify(join(source, "external-link"))}]) {
 assert.equal(typeof fs.readFileSync(path,'utf8'),'string');
 denied(()=>fs.writeFileSync(path,'escape')); denied(()=>fs.chmodSync(path,0o777));
 if(path!==scratch+'/source-link') { denied(()=>fs.unlinkSync(path)); denied(()=>fs.renameSync(path,scratch+'/stolen')); }
}
denied(()=>fs.linkSync(file,scratch+'/hardlink'));
denied(()=>fs.writeFileSync(${JSON.stringify(outside)},'escape'));
denied(()=>fs.writeFileSync(agent+'/settings.json','escape'));
fs.writeFileSync(scratch+'/scratch-ok','ok');
denied(()=>fs.writeFileSync(agent+'/auth.json','forbidden'));
denied(()=>fs.mkdirSync(agent+'/auth.json.lock'));
fs.writeFileSync(${JSON.stringify(join(storageDir, "state"))},'durable');
fs.writeFileSync(${JSON.stringify(join(root, "session", "artifacts", "artifact"))},'artifact');
const nested=cp.spawnSync('/usr/bin/unshare',['--user','--map-root-user','--mount','true']);
assert.equal(nested.error,undefined);
assert.notEqual(nested.status,0,'nested namespaces must not permit remounting');
const mount=cp.spawnSync('/bin/mount',['-o','remount,rw','/']);assert.notEqual(mount.status,0);
`;
	const brokerCheck = `(async()=>{const {credentialClient}=await import(${JSON.stringify(import.meta.resolve("@pilot/kernel/credential-client"))}); const client=credentialClient(); await client.pi.modify('fixture',async current=>{const n=Number(current.access)+1;return {...current,access:String(n),refresh:'r'+n};}); await client.close();})().catch(()=>{process.exitCode=1;});`;
	await writeFile(
		entry,
		`${checks}\ncp.execFileSync(process.execPath,['-e',${JSON.stringify(`${checks}\ncp.execFileSync(process.execPath,['-e',${JSON.stringify(checks + "\n" + brokerCheck)}]);\n${brokerCheck}`)}]);(async()=>{const {credentialClient}=await import(${JSON.stringify(import.meta.resolve("@pilot/kernel/credential-client"))});const client=credentialClient();await client.pi.modify('fixture',async current=>({...current,access:String(Number(current.access)+1)}));await client.close();process.send({verified:true});process.disconnect();})().catch(()=>{process.exitCode=1;process.disconnect();});`,
	);

	const view = { scratch, protectedPaths: [source] };
	// Exercise the public launcher, not a hand-assembled sandbox command.
	const child = await forkMainViewWorker(entry, view, state);
	t.after(() => {
		child.kill("SIGKILL");
	});
	const exit = once(child, "exit");
	const result = await Promise.race([
		once(child, "message"),
		exit.then(([code, signal]) => {
			throw new Error(`Isolated child exited before IPC: ${code}/${signal}`);
		}),
	]);
	assert.deepEqual(result[0], { verified: true });
	assert.equal((await exit)[0], 0);
	assert.equal(await readFile(file, "utf8"), "protected");
	assert.equal(await readFile(outside, "utf8"), "host");
	assert.equal(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")).fixture.access, "3");
	await assert.rejects(readFile(join(root, "session", "coordinator-auth", "auth.json")), { code: "ENOENT" });
	assert.equal(await readFile(join(storageDir, "state"), "utf8"), "durable");
	// A second host bind-mount path to the source must also be readonly, not just a symlink alias.
	const mounted = join(root, "mounted-source");
	await mkdir(mounted);
	const bindEntry = join(root, "bind-child.cjs");
	await writeFile(
		bindEntry,
		`const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(fs.readFileSync(${JSON.stringify(join(mounted, "file"))},'utf8'),'protected');
assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(mounted, "file"))},'escape'),{code:'EROFS'});
process.send('bind-verified');process.disconnect();`,
	);
	const module = new URL("./linux-coordinator.ts", import.meta.url).href;
	const driver = `import {forkLinuxCoordinator} from ${JSON.stringify(module)};
import {once} from 'node:events';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const credentials=JSON.parse(await readFile(${JSON.stringify(capabilityFile)},'utf8'));
const child=await forkLinuxCoordinator(${JSON.stringify(bindEntry)},${JSON.stringify(view)},{...${JSON.stringify({ storageDir, agentDir })},credentials});
const exit=once(child,'exit');const message=await Promise.race([once(child,'message'),exit.then(()=>{throw Error('guard rejected bind alias')})]);
assert.equal(message[0],'bind-verified');assert.equal((await exit)[0],0);`;
	// The privileged fixture only creates a bind mount in a disposable, non-propagating CI
	// mount namespace. The actual launcher and kernel still run as the unprivileged runner.
	async function bindFixture(destination: string, code: string, origin = source) {
		assert.equal(process.env.GITHUB_ACTIONS, "true", "Privileged bind fixtures are CI-only");
		await promisify(execFile)(
			"sudo",
			[
				"-n",
				"unshare",
				"--mount",
				"--fork",
				"--propagation",
				"private",
				"/bin/sh",
				"-ceu",
				'mount --bind "$1" "$2"; exec setpriv --reuid="$3" --regid="$4" --clear-groups "$5" --input-type=module -e "$6"',
				"pilot-bind-fixture",
				origin,
				destination,
				String(process.getuid!()),
				String(process.getgid!()),
				process.execPath,
				code,
			],
			{ timeout: 15_000 },
		);
	}
	if (process.env.PILOT_LINUX_BIND_FIXTURES === "1") await bindFixture(mounted, driver);
	if (process.env.PILOT_LINUX_BIND_FIXTURES === "1") {
		const ancestorAlias = join(root, "ancestor-alias");
		await mkdir(ancestorAlias);
		await bindFixture(
			ancestorAlias,
			`import {forkLinuxCoordinator} from ${JSON.stringify(module)};import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const credentials=JSON.parse(await readFile(${JSON.stringify(capabilityFile)},'utf8'));
await assert.rejects(forkLinuxCoordinator(${JSON.stringify(bindEntry)},${JSON.stringify(view)},{storageDir:${JSON.stringify(join(ancestorAlias, "durable"))},agentDir:${JSON.stringify(agentDir)},credentials}),/alias.*overlap/);
await assert.rejects(readFile(${JSON.stringify(join(source, "durable"))}),{code:'ENOENT'});assert.equal(await readFile(${JSON.stringify(file)},'utf8'),'protected');`,
		);
	}
	// Never recursively clean a legacy auth path on the host before isolation: it could itself
	// be a bind alias. These unreleased snapshots are unused, not a reason to traverse host state.
	if (process.env.PILOT_LINUX_BIND_FIXTURES === "1") {
		const legacy = join(root, "session", "coordinator-auth"),
			legacyEntry = join(root, "legacy.cjs");
		await mkdir(legacy);
		await writeFile(legacyEntry, "process.disconnect();");
		await bindFixture(
			legacy,
			`import {forkLinuxCoordinator} from ${JSON.stringify(module)};import {readFile} from 'node:fs/promises';import {once} from 'node:events';import assert from 'node:assert/strict';
const credentials=JSON.parse(await readFile(${JSON.stringify(capabilityFile)},'utf8'));
const child=await forkLinuxCoordinator(${JSON.stringify(legacyEntry)},${JSON.stringify(view)},{...${JSON.stringify({ storageDir, agentDir })},credentials});const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(await readFile(${JSON.stringify(file)},'utf8'),'protected');`,
		);
	}
	// Writable exceptions must reject nested bind mounts, otherwise an alias inside scratch would
	// make protected inodes writable despite the read-only source mount and nlink==1 checks.
	const scratchMount = join(scratch, "mounted-source");
	await mkdir(scratchMount);
	if (process.env.PILOT_LINUX_BIND_FIXTURES === "1")
		await bindFixture(
			scratchMount,
			`
import {validateCoordinatorWrites} from ${JSON.stringify(module)};import assert from 'node:assert/strict';
await assert.rejects(validateCoordinatorWrites([${JSON.stringify(scratch)}],[${JSON.stringify(source)}]),/mount point/);
`,
		);
	await link(file, join(scratch, "preexisting-hardlink"));
	await assert.rejects(forkLinuxCoordinator(entry, view, state), /hardlink/);
	await rm(join(scratch, "preexisting-hardlink"));
	if (process.env.PILOT_LINUX_BIND_FIXTURES === "1") {
		const hostProc = join(root, "host-proc");
		await mkdir(hostProc);
		await bindFixture(
			hostProc,
			`import {forkLinuxCoordinator} from ${JSON.stringify(module)};import {readFile} from 'node:fs/promises';import {once} from 'node:events';import assert from 'node:assert/strict';
const credentials=JSON.parse(await readFile(${JSON.stringify(capabilityFile)},'utf8'));
const child=await forkLinuxCoordinator(${JSON.stringify(bindEntry)},${JSON.stringify(view)},{...${JSON.stringify({ storageDir, agentDir })},credentials});
let imported=false;child.on('message',()=>{imported=true});const [code]=await once(child,'exit');assert.notEqual(code,0);assert.equal(imported,false);`,
			"/proc",
		);
	}
});

test("namespace/security-policy denial and missing sandbox tooling remain actionable and fail closed", {
	skip: process.platform !== "linux",
	timeout: 30_000,
}, async (t) => {
	const capability = await probeLinuxCoordinatorIsolation();
	if (!capability.available) {
		assert.match(capability.detail!, /bubblewrap|namespace/);
		assert.match(capability.detail!, /dnf install bubblewrap/);
		assert.match(capability.detail!, /Refusing an unrestricted/);
		assert.notEqual(process.env.PILOT_REQUIRE_LINUX_ISOLATION, "1", capability.detail);
		return;
	}
	const probe = fileURLToPath(new URL("./linux-coordinator-probe.ts", import.meta.url));
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-denied-policy-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = join(root, "bwrap");
	await copyFile("/usr/bin/bwrap", executable);
	const base = [
		"--unshare-user",
		"--disable-userns",
		"--unshare-pid",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
	];
	// Map the fixture owner to root so the copied binary is root-owned in the outer userns.
	// This reaches the real namespace restriction, rather than failing binary-ownership validation.
	const restricted = [...base, "--uid", "0", "--ro-bind", executable, "/usr/bin/bwrap"];
	await assert.rejects(
		promisify(execFile)("/usr/bin/bwrap", [...restricted, process.execPath, probe]),
		(error: unknown) => {
			const result = JSON.parse((error as { stdout: string }).stdout);
			assert.equal(result.available, false);
			assert.match(result.detail, /Command failed:.*bwrap/s);
			assert.match(result.detail, /namespace|Operation not permitted/);
			assert.doesNotMatch(result.detail, /bubblewrap executable is required/);
			return true;
		},
	);
	// Hide both supported installation paths. Mere unshare presence must never enable isolation.
	const absent = [...base, "--ro-bind", "/dev/null", "/usr/bin/bwrap"];
	if ((await realpath("/bin/bwrap")) !== (await realpath("/usr/bin/bwrap")))
		absent.push("--ro-bind", "/dev/null", "/bin/bwrap");
	const result = execFileSync(
		"/usr/bin/bwrap",
		[
			...absent,
			process.execPath,
			"--input-type=module",
			"-e",
			`
import {probeLinuxCoordinatorIsolation} from ${JSON.stringify(new URL("./linux-coordinator.ts", import.meta.url).href)};
const result=await probeLinuxCoordinatorIsolation(); console.log(JSON.stringify(result));
`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(JSON.parse(result).available, false);
	assert.match(JSON.parse(result).detail, /bubblewrap executable is required/);
});

test("real Linux kernel opens durable storage and native resources only after boundary validation", {
	skip: process.platform !== "linux",
	timeout: 60_000,
}, async (t) => {
	const capability = await probeLinuxCoordinatorIsolation();
	if (!capability.available) {
		assert.notEqual(process.env.PILOT_REQUIRE_LINUX_ISOLATION, "1", capability.detail);
		t.skip(capability.detail);
		return;
	}
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-linux-kernel-")));
	const scratch = join(root, "session", "scratch");
	const source = join(root, "source");
	const agentDir = join(root, "agent");
	for (const path of [scratch, source, agentDir]) await mkdir(path, { recursive: true, mode: 0o700 });
	await writeFile(
		join(agentDir, "fixture.ts"),
		`
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
import {writeFileSync} from 'node:fs';
export default pi => { const faux=fauxProvider();writeFileSync(process.env.TMPDIR+'/fixture-registration.json',JSON.stringify({id:faux.provider.id,models:faux.provider.getModels().map(m=>m.id)}));pi.on('session_start',(_event,ctx)=>{const all=ctx.modelRegistry.getAll?.()??ctx.modelRegistry.getModels?.()??[];writeFileSync(process.env.TMPDIR+'/fixture-models.json',JSON.stringify(all.filter(m=>m.provider==='faux').map(m=>m.id)));}); faux.setResponses([fauxAssistantMessage('isolated kernel')]); pi.registerProvider({...faux.provider,auth:{oauth:{name:'Broker fixture',login:async()=>{throw Error('No login')},refresh:async current=>({...current,access:'child-broker',expires:Date.now()+3600000}),toAuth:async current=>({apiKey:current.access})}}}); };
`,
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: [join(agentDir, "fixture.ts")],
			defaultProvider: "faux",
			defaultModel: "faux-1",
		}),
	);
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({ faux: { type: "oauth", access: "expired", refresh: "grant", expires: 0 } }),
		{ mode: 0o600 },
	);
	const broker = new CredentialBroker(agentDir);
	await broker.start();
	const credentials = broker.grant();
	const spec: KernelSpec = {
		credentials,
		projectTrusted: false,
		sessionId: randomUUID(),
		storageDir: join(root, "session", "durable"),
		cwd: scratch,
		agentDir,
		model: "faux/faux-1",
		pilot: { coordinatorView: { path: source, scratch, protectedPaths: [source] } },
	};
	const offline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	let worker: Worker | undefined;
	let subagent: import("node:child_process").ChildProcess | undefined;
	let subagentExit: Promise<unknown> | undefined;
	try {
		const child = await forkMainViewWorker(fileURLToPath(workerEntry), spec.pilot!.coordinatorView!, {
			storageDir: spec.storageDir,
			agentDir,
			credentials,
		});
		worker = new Worker(
			spec,
			() => {},
			() => {},
			undefined,
			{ child },
		);
		await worker.ready;
		assert.equal(worker.state, "idle");
		await worker.request({ type: "activity", requestId: randomUUID(), text: "Sandbox opened" });
		assert.ok((await readFile(join(spec.storageDir, "harness.sqlite"))).length > 0);
		await worker.close();
		// Exercise the actual immutable child adapter, not just a generic descendant script. Any
		// unbrokered SDK refresh would fail its auth.json write in this read-only mount namespace.
		const childEnvironment = {
			PI_CODE_MODE_SUBAGENT: "1",
			PI_SUBAGENT_HOST_PACKAGE_DIR: getPackageDir(),
			PI_CODING_AGENT_DIR: agentDir,
			PILOT_PI_EXTENSIONS_PROFILE: CHILD_PROFILE_PATH,
			PILOT_ANTHROPIC_AUTH_EXTENSION: ANTHROPIC_AUTH_PATH,
		};
		const old = Object.fromEntries(Object.keys(childEnvironment).map((key) => [key, process.env[key]]));
		try {
			Object.assign(process.env, childEnvironment);
			subagent = await forkMainViewWorker(CHILD_WORKER_ENTRY, spec.pilot!.coordinatorView!, {
				storageDir: spec.storageDir,
				agentDir,
				credentials,
			});
		} finally {
			for (const [key, value] of Object.entries(old)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		subagentExit = once(subagent, "exit");
		const packets: Array<{ type: string; id?: string; result?: { ok?: boolean }; error?: string }> = [];
		const listeners = new Set<() => void>();
		subagent.on("message", (value) => {
			const message = value as (typeof packets)[number];
			if (["ready", "answer", "error", "paused"].includes(message.type)) packets.push(message);
			for (const notify of listeners) notify();
		});
		const packet = (type: string) =>
			new Promise<(typeof packets)[number]>((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(check);
					reject(new Error("Child broker fixture did not answer"));
				}, 20000);
				const check = () => {
					const found = packets.find((p) => p.type === type || p.type === "error");
					if (!found) return;
					clearTimeout(timer);
					listeners.delete(check);
					found.type === "error" ? reject(new Error(found.error ?? "Child failed")) : resolve(found);
				};
				listeners.add(check);
				check();
			});
		subagent.send({
			type: "start",
			spec: {
				name: "broker-child",
				directory: join(spec.storageDir, "child"),
				request: {
					agent: { config: { name: "task" }, systemPrompt: "", sourcePath: "<builtin>", scope: "builtin" },
					task: "Reply",
					index: 0,
					overrides: { model: "faux/faux-1" },
				},
				context: {
					cwd: scratch,
					sessionId: spec.sessionId,
					runId: "broker-child",
					timeoutMs: 20000,
					projectTrusted: false,
				},
			},
		});
		await packet("ready");
		subagent.send({ type: "input", id: "auth", message: "Reply", followUp: false });
		assert.equal((await packet("answer")).result?.ok, true);
		assert.equal(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")).faux.access, "child-broker");
		subagent.send({ type: "pause" });
		await packet("paused");
		await subagentExit;
	} catch (error) {
		t.diagnostic(
			"Fixture registration: " +
				(await readFile(join(scratch, "fixture-registration.json"), "utf8").catch(() => "not imported")),
		);
		t.diagnostic(
			"Fixture models: " + (await readFile(join(scratch, "fixture-models.json"), "utf8").catch(() => "not bound")),
		);
		throw error;
	} finally {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
		await worker?.close();
		if (subagent?.exitCode === null && subagent?.signalCode === null) subagent.kill("SIGKILL");
		await subagentExit;
		await broker.close();
		await rm(root, { recursive: true, force: true });
	}
});
