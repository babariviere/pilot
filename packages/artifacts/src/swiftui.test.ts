import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewArtifact } from "./preview.ts";
import { validateArtifact } from "./render.ts";
import { ArtifactStore } from "./store.ts";

const source =
	'struct ArtifactView: View { var body: some View { VStack { Text("Native preview").font(.title); Button("Continue") {} }.padding(24) } }';
const document = { title: "Native card", kind: "swiftui" as const, source };
const native =
	process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && process.env.PILOT_SWIFTUI_TESTS === "1";

test("SwiftUI validates source, libraries and cancellation before running native commands", async () => {
	assert.deepEqual(validateArtifact(document), { ...document, libraries: [] });
	assert.throws(() => validateArtifact({ ...document, libraries: ["react"] }), /SwiftUI.*libraries/);
	assert.throws(() => validateArtifact({ ...document, source: "" }), /1-512 KiB/);
	assert.throws(() => validateArtifact({ ...document, source: "x".repeat(512 * 1024 + 1) }), /1-512 KiB/);
	await assert.rejects(previewArtifact(document, { signal: AbortSignal.abort() }), /abort/i);
	await assert.rejects(previewArtifact(document, { width: 1 }), /width/);
	if (process.platform !== "darwin") await assert.rejects(previewArtifact(document), /require macOS/);
});

test("SwiftUI natively renders a viewport and denies user files, environment, network and subprocesses", {
	skip: !native,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-swiftui-test-"));
	const secret = join(directory, "secret.txt");
	const target = join(directory, "escaped.txt");
	let connections = 0;
	const server = createServer((socket) => {
		connections++;
		socket.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const previous = process.env.PILOT_SWIFTUI_TEST_SECRET;
	process.env.PILOT_SWIFTUI_TEST_SECRET = "must-not-leak";
	try {
		await writeFile(secret, "private-test-data");
		const probe = `import Darwin
struct ArtifactView: View {
  init() {
    print("file", (try? String(contentsOfFile: ${JSON.stringify(secret)}, encoding: .utf8)) == nil ? "blocked" : "LEAK")
    do { try "escape".write(toFile: ${JSON.stringify(target)}, atomically: false, encoding: .utf8); print("write LEAK") } catch { print("write blocked") }
    print("environment", ProcessInfo.processInfo.environment["PILOT_SWIFTUI_TEST_SECRET"] == nil ? "blocked" : "LEAK")
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(${address.port}).bigEndian
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
    let connected = fd == -1 ? -1 : withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    print("network", connected == -1 ? "blocked" : "LEAK")
    if fd != -1 { close(fd) }
    let child = Process(); child.executableURL = URL(fileURLWithPath: "/bin/echo")
    do { try child.run(); child.waitUntilExit(); print("process LEAK") } catch { print("process blocked") }
  }
  var body: some View { VStack { Text("Sandboxed SwiftUI").font(.title); Button("Continue") {} }.padding(24) }
}`;
		const result = await previewArtifact({ ...document, source: probe }, { width: 400, height: 300 });
		const png = Buffer.from(result.screenshot.data, "base64");
		assert.ok(png.length > 1000);
		assert.equal(png.readUInt32BE(16), 400);
		assert.equal(png.readUInt32BE(20), 300);
		assert.equal(result.contentHeight, 300);
		for (const capability of ["file", "write", "environment", "network", "process"])
			assert.ok(
				result.consoleMessages.some((message) => message.text === `${capability} blocked`),
				JSON.stringify(result.consoleMessages),
			);
		assert.equal(existsSync(target), false);
		assert.equal(connections, 0, "native code must not connect to the listening localhost server");
	} finally {
		if (previous === undefined) delete process.env.PILOT_SWIFTUI_TEST_SECRET;
		else process.env.PILOT_SWIFTUI_TEST_SECRET = previous;
		await rm(directory, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

test("SwiftUI publishes editable source and durable screenshots, and failed updates preserve latest", {
	skip: !native,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-native-store-"));
	try {
		const store = new ArtifactStore(directory, { sessionId: "native", projectId: "project" });
		const first = await store.create(document);
		assert.equal(first.kind, "swiftui");
		assert.equal(first.source, source);
		assert.deepEqual(first.libraries, []);
		assert.match(first.html, /data:image\/png;base64,/);
		assert.match(first.html, /width:auto;height:auto;max-width:min\(100vw,800px\);max-height:min\(100vh,600px\)/);
		assert.doesNotMatch(first.html, /struct ArtifactView/);
		const reopened = new ArtifactStore(directory, { sessionId: "native" });
		assert.deepEqual(await reopened.get(first.id), first);
		assert.equal((await reopened.list())[0]?.kind, "swiftui");
		await assert.rejects(
			store.update(first.id, { ...document, source: "struct ArtifactView: View { invalid Swift }" }, 1),
			/compile[\s\S]*error:/,
		);
		assert.equal((await reopened.get(first.id)).revision, 1);
		const second = await store.update(
			first.id,
			{ ...document, source: source.replace("Native preview", "Updated preview") },
			1,
		);
		assert.equal(second.revision, 2);
		assert.notEqual(first.html, second.html);
		assert.equal((await reopened.get(first.id, 1)).html, first.html);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("SwiftUI cancellation kills compiler children and removes its disposable directory", {
	skip: !native,
}, async () => {
	const before = new Set(await readdir(tmpdir()));
	const controller = new AbortController();
	// Unique source avoids the in-memory result cache. A warm compile takes about a second, so abort early.
	const fresh = { ...document, source: source.replace("Native preview", `Cancelled ${Date.now()}`) };
	const timer = setTimeout(() => controller.abort(), 400);
	try {
		await assert.rejects(previewArtifact(fresh, { signal: controller.signal }), /abort/i);
		const after = await readdir(tmpdir());
		assert.deepEqual(
			after.filter((name) => name.startsWith("pilot-swiftui-") && !before.has(name)),
			[],
		);
		// The cancelled compile released its slot lock, so the next compile can use the warm slot.
		const started = Date.now();
		await previewArtifact({ ...fresh, source: fresh.source.replace("Cancelled", "Recovered") });
		assert.ok(Date.now() - started < 60_000);
	} finally {
		clearTimeout(timer);
	}
});
