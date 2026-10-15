/** Execute the selected native modules on Linux. A distro label cannot prove CPU/libc/Node ABI compatibility. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { getLibrary, prepareArtifact } from "@pilot/artifacts";

test("artifact compiler emits the smoke component in its encoded script payload", async () => {
	const artifact = await prepareArtifact({
		title: "Native compiler smoke",
		kind: "react",
		source: "export default function Artifact() { return <p>native-esbuild-ok</p>; }",
	});
	assert.match(artifact.html, /artifact-root/);
	const payload = /atob\("([A-Za-z0-9+/=]+)"\)/.exec(artifact.html)?.[1];
	assert.ok(payload, "Compiled script payload is missing");
	assert.match(Buffer.from(payload, "base64").toString("utf8"), /native-esbuild-ok/);
	assert.ok((await getLibrary("react")).length > 0);
});

test("Linux x64 runtime loads SQLite, PTY and artifact compiler with compatible native ABIs", {
	skip: process.platform !== "linux",
	timeout: 30_000,
}, async (t) => {
	assert.equal(process.arch, "x64");
	assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+ is required");
	t.diagnostic(
		JSON.stringify({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi }),
	);
	const db = new DatabaseSync(":memory:");
	try {
		db.exec("CREATE TABLE smoke (value TEXT)");
		db.prepare("INSERT INTO smoke VALUES (?)").run("native-sqlite-ok");
		assert.equal(db.prepare("SELECT value FROM smoke").get()?.value, "native-sqlite-ok");
	} finally {
		db.close();
	}
	const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
	const terminal = pty.spawn("/bin/sh", ["-c", "printf native-pty-ok"], {
		cwd: process.cwd(),
		env: { PATH: "/usr/bin:/bin" },
	});
	let output = "";
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			terminal.kill();
			reject(new Error("Native PTY timeout"));
		}, 5000);
		terminal.onData((data) => {
			output += data;
		});
		terminal.onExit(({ exitCode }) => {
			clearTimeout(timeout);
			exitCode === 0 ? resolve() : reject(new Error(`Native PTY exit ${exitCode}`));
		});
	});
	assert.match(output, /native-pty-ok/);
	await assert.rejects(
		prepareArtifact({
			title: "Unsupported native artifact",
			kind: "swiftui",
			source: 'struct ArtifactView: View { var body: some View { Text("No Linux renderer") } }',
		}),
		/require macOS/,
	);
	const report = process.report.getReport() as { sharedObjects: string[]; header: { glibcVersionRuntime?: string } };
	t.diagnostic(JSON.stringify({ glibc: report.header.glibcVersionRuntime ?? "not reported" }));
	const addons = report.sharedObjects.filter((file) => file.endsWith(".node"));
	assert.ok(
		addons.some((file) => file.includes("pty")),
		"PTY addon was not loaded",
	);
	for (const binary of [process.execPath, ...addons]) {
		const file = await open(binary, "r");
		const header = Buffer.alloc(20);
		try {
			await file.read(header, 0, header.length, 0);
		} finally {
			await file.close();
		}
		assert.equal(header.subarray(0, 4).toString("hex"), "7f454c46", `Not ELF: ${binary}`);
		assert.equal(header[4], 2, "Native runtime must be 64-bit");
		assert.equal(header[5], 1, "Native runtime must be little endian");
		assert.equal(header.readUInt16LE(18), 62, "Native runtime must be x86-64");
		const dependencies = await promisify(execFile)("ldd", [binary], { timeout: 5000, maxBuffer: 64 * 1024 });
		assert.doesNotMatch(
			dependencies.stdout + dependencies.stderr,
			/not found/i,
			`Unresolved native dependencies: ${binary}`,
		);
	}
});
