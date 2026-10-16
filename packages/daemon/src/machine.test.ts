import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MachineInformationReader, onlineCpuCount, osLabel } from "./machine.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

function fixture() {
	const reads: [string, number][] = [];
	const disks: string[] = [];
	return {
		reads,
		disks,
		source: {
			platform: "linux",
			async read(path: string, limit: number) {
				reads.push([path, limit]);
				return (
					(
						{
							"/etc/os-release": 'PRETTY_NAME="Fixture Linux 1"\n',
							"/proc/cpuinfo": "processor : 0\nmodel name : Fixture CPU\n",
							"/sys/devices/system/cpu/online": "0-3,8-11\n",
						} as Record<string, string>
					)[path] ?? null
				);
			},
			async disk(path: string) {
				disks.push(path);
				return { totalBytes: 1_000_000, availableBytes: 250_000 };
			},
			kernel: () => "6.fixture",
			architecture: () => "x64",
			memory: () => 16_000_000_000,
		},
	};
}

test("bounded read-only observations use only fixed fields and the runtime volume, with no service inference", async () => {
	const f = fixture();
	const reader = new MachineInformationReader("/fixture/data", "1.2.3", f.source);
	const value = await reader.read();
	assert.equal(value.os, "Fixture Linux 1");
	assert.equal(value.cpuModel, "Fixture CPU");
	assert.equal(value.logicalCpuCount, 8);
	assert.equal(value.memoryTotalBytes, 16_000_000_000);
	assert.equal(value.kernel, "6.fixture");
	assert.equal(value.architecture, "x64");
	assert.equal(value.runtime.state, "running");
	assert.equal(value.runtime.version, "1.2.3");
	assert.equal(value.service.state, "unknown");
	assert.deepEqual(value.disk, { scope: "runtime-data", totalBytes: 1_000_000, availableBytes: 250_000 });
	assert.deepEqual(f.reads, [
		["/etc/os-release", 16_384],
		["/proc/cpuinfo", 65_536],
		["/sys/devices/system/cpu/online", 4_096],
	]);
	assert.deepEqual(f.disks, ["/fixture/data"]);
	assert.deepEqual(await reader.read(), value);
	assert.equal(f.disks.length, 1);
});

test("missing, denied, unsupported and invalid fields remain unavailable without leaking diagnostics", async () => {
	const f = fixture();
	f.source.read = async () => {
		throw new Error("private system diagnostic");
	};
	f.source.disk = async () => {
		throw new Error("private volume diagnostic");
	};
	f.source.memory = () => Number.NaN;
	f.source.kernel = () => {
		throw new Error("private kernel diagnostic");
	};
	const value = await new MachineInformationReader("/fixture", "1.2.3", f.source).read();
	for (const key of ["os", "cpuModel", "logicalCpuCount", "memoryTotalBytes", "kernel"] as const)
		assert.equal(value[key], null);
	assert.equal(value.disk.totalBytes, null);
	assert.ok(!JSON.stringify(value).includes("private"));
	f.source.platform = "unsupported";
	f.source.read = async () => {
		assert.fail("No Linux files on unsupported hosts");
	};
	assert.equal((await new MachineInformationReader("/fixture", "1.2.3", f.source).read()).os, null);
	for (const text of [null, "", "-1", "4-2", "0-3,2-4", "0,0", "0-999999999999999", "NaN"])
		assert.equal(onlineCpuCount(text), null);
	assert.equal(osLabel("NAME=Fixture"), null);
	assert.equal(osLabel('PRETTY_NAME="Fixture\u001b[31m"'), "Fixture[31m");
});

test("concurrent requests share one bounded collection, including a stuck read after its response deadline", async () => {
	const f = fixture();
	const releases: ((value: string) => void)[] = [];
	let calls = 0;
	f.source.read = () => {
		calls++;
		return new Promise<string>((done) => {
			releases.push(done);
		});
	};
	// All three reads stay pending. Timeouts must never open another collection slot.
	const reader = new MachineInformationReader("/fixture", "1.2.3", f.source, 5);
	const [a, b] = await Promise.all([reader.read(), reader.read()]);
	assert.equal(a.os, null);
	assert.equal(b.runtime.state, "running");
	await reader.read();
	assert.equal(calls, 3);
	for (const release of releases) release("0");
});

test("host-specific readers never share observations or volumes", async () => {
	const a = fixture(),
		b = fixture();
	b.source.memory = () => 8_000_000_000;
	const [first, second] = await Promise.all([
		new MachineInformationReader("/a", "1.0.0", a.source).read(),
		new MachineInformationReader("/b", "2.0.0", b.source).read(),
	]);
	assert.notEqual(first.runtime.version, second.runtime.version);
	assert.notEqual(first.memoryTotalBytes, second.memoryTotalBytes);
	assert.deepEqual(a.disks, ["/a"]);
	assert.deepEqual(b.disks, ["/b"]);
});

test("machine endpoint is GET-only, no-store and protected by existing loopback origin guards", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-machine-"));
	const value = await new MachineInformationReader(home, "1.2.3", fixture().source).read();
	const reads = t.mock.method(MachineInformationReader.prototype, "read", async () => value);
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects),
		terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/machine`;
	const response = await fetch(base);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), value);
	for (const [path, options, expected] of [
		[base, { method: "POST" }, 405],
		[`${base}/extra`, {}, 404],
		[base, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const result = await fetch(path, options);
		assert.equal(result.status, expected);
		await result.arrayBuffer();
	}
	assert.equal(reads.mock.callCount(), 1);
});
