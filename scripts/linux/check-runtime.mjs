/** Runs from the relocated production tree with its bundled Node. Offline, no user accounts/config. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.versions.node, "24.21.0");
assert.match(execFileSync(join(root, "bin/jj"), ["--version"], { encoding: "utf8" }), /jj 0\.46\./);
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES ('sqlite-ok')");
assert.equal(db.prepare("SELECT value FROM smoke").get().value, "sqlite-ok");
db.close();
const isolated = await mkdtemp(join(tmpdir(), "pilot-production-smoke-"));
process.env.PI_CODING_AGENT_DIR = isolated;
globalThis.fetch = () => {
	throw new Error("Production runtime smoke must stay offline");
};
let adapter;
try {
	const { NativeAdapter } = await import("./packages/kernel/src/native-adapter.ts");
	const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider } = await import("@earendil-works/pi-ai");
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider();
	models.registerNativeProvider(faux.provider);
	adapter = await NativeAdapter.open({
		cwd: isolated,
		agentDir: isolated,
		projectTrusted: false,
		sessionId: "linux-production-smoke",
		sessionFile: join(isolated, "native.jsonl"),
		settingsManager: SettingsManager.inMemory(),
		sessionOptions: { modelRuntime: models, model: faux.getModel() },
	});
	for (const name of ["applyPatch", "web", "browser", "jobs", "subagent"])
		assert.ok(adapter.session.getCallableToolNames().includes(name), name);
	const { prepareArtifact, getLibrary } = await import("@pilot/artifacts");
	const artifact = await prepareArtifact({
		title: "Linux production smoke",
		kind: "react",
		source: "export default function Artifact() { return <p>production-ok</p>; }",
	});
	assert.match(artifact.html, /artifact-root/);
	assert.ok((await getLibrary("mermaid")).length > 0);
	const pty = createRequire(import.meta.url)("node-pty");
	const terminal = pty.spawn("/bin/sh", ["-c", "printf production-pty-ok"], {
		cwd: isolated,
		env: { PATH: "/usr/bin:/bin" },
	});
	let output = "";
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			terminal.kill();
			reject(new Error("Production PTY timeout"));
		}, 10000);
		terminal.onData((data) => {
			output += data;
		});
		terminal.onExit(({ exitCode }) => {
			clearTimeout(timeout);
			exitCode === 0 ? resolve() : reject(new Error(`PTY exit ${exitCode}`));
		});
	});
	assert.match(output, /production-pty-ok/);
} finally {
	await adapter?.close();
	await rm(isolated, { recursive: true, force: true });
}
console.log(
	JSON.stringify({
		productionRuntime: "ok",
		node: process.versions.node,
		modules: process.versions.modules,
		glibc: process.report.getReport().header.glibcVersionRuntime,
	}),
);
