/** Compile untrusted, standalone SwiftUI in a disposable macOS sandbox. */
import { execFile, spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactPreview } from "./preview.ts";

const MAX_OUTPUT = 32 * 1024;
// A cold Swift SDK module cache can take minutes on a busy machine.
const TIMEOUT = 300_000;

/** Check the selected installed toolchain without launching Swift or an installer. */
export function isSwiftUIPreviewAvailable(): boolean {
	return (
		process.platform === "darwin" &&
		existsSync("/usr/bin/sandbox-exec") &&
		spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], {
			timeout: 2000,
			stdio: "ignore",
			env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
		}).status === 0
	);
}

/** Fixed paths are quoted as Scheme strings, never interpolated as sandbox rules. */
function profile(directory: string, toolchain: string, sdk: string, compiling: boolean): string {
	return `(version 1)
(deny default)
(allow sysctl-read)
(allow process-info* (target self))
(allow file-read-metadata)
(allow file-read* ${["/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot", "/usr/lib", "/usr/share", "/usr/bin", "/usr/include", "/bin", "/sbin", "/private/preboot", "/private/var/db/dyld", "/Library/Developer", "/Library/Fonts", "/Library/Preferences", directory, toolchain, sdk].map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")}
  (literal "/")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime"))
(allow file-write* (subpath ${JSON.stringify(directory)}) (literal "/dev/null"))
(allow mach-lookup
  (global-name "com.apple.FontObjectsServer")
  (global-name "com.apple.cfprefsd.daemon"))
${compiling ? "(allow process-exec)\n(allow process-fork)" : `(allow process-exec (literal ${JSON.stringify(join(directory, "preview"))}))`}
`;
}

/** Kill the entire compiler/helper process group, including macro/plugin children. */
async function run(
	command: string,
	args: string[],
	options: { directory: string; signal?: AbortSignal; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
	options.signal?.throwIfAborted();
	const stage = command === "/usr/bin/xcrun" ? "toolchain lookup" : args.includes("-sdk") ? "compile" : "render";
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.directory,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
				HOME: options.directory,
				TMPDIR: `${options.directory}/`,
				CLANG_MODULE_CACHE_PATH: join(options.directory, "cache"),
			},
		});
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		const stop = (error: Error) => {
			if (failure) return;
			failure = error;
			// swift-driver puts frontend children in their own process groups.
			// Snapshot descendants before killing the driver so they cannot be orphaned.
			execFile("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 5000, maxBuffer: 1024 * 1024 }, (_error, output) => {
				const rows = output
					.trim()
					.split("\n")
					.map((line) => line.trim().split(/\s+/).map(Number));
				const descendants = new Set<number>(child.pid ? [child.pid] : []);
				for (let changed = true; changed; ) {
					changed = false;
					for (const [pid, parent] of rows)
						if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
							descendants.add(pid);
							changed = true;
						}
				}
				for (const pid of [...descendants].reverse()) {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						/* Not a group leader. */
					}
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* Already exited. */
					}
				}
			});
		};
		const abort = () => stop(new Error("SwiftUI artifact preview aborted"));
		const timer = setTimeout(
			() =>
				stop(new Error(`SwiftUI artifact ${stage} timed out after ${Math.ceil(options.timeout / 1000)} seconds`)),
			options.timeout,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString()).slice(0, MAX_OUTPUT);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(0, MAX_OUTPUT);
		});
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code, signal) => {
			cleanup();
			if (failure) reject(failure);
			else if (code !== 0)
				reject(new Error(`SwiftUI artifact ${stage} failed (${code ?? signal}):\n${stderr || stdout}`));
			else resolve({ stdout, stderr });
		});
	});
}

export async function previewSwiftUI(
	source: string,
	options: { width?: number; height?: number; signal?: AbortSignal } = {},
): Promise<ArtifactPreview> {
	options.signal?.throwIfAborted();
	if (process.platform !== "darwin") throw new Error("SwiftUI artifacts require macOS and Swift Command Line Tools");
	const width = options.width ?? 800;
	const height = options.height ?? 600;
	if (
		!Number.isInteger(width) ||
		width < 240 ||
		width > 1600 ||
		!Number.isInteger(height) ||
		height < 200 ||
		height > 1600
	)
		throw new Error("Preview width must be 240-1600 and height 200-1600 pixels");
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pilot-swiftui-")));
	const deadline = Date.now() + TIMEOUT;
	const execute = (command: string, args: string[], timeout = TIMEOUT) =>
		run(command, args, {
			directory,
			signal: options.signal,
			timeout: Math.max(1, Math.min(timeout, deadline - Date.now())),
		});
	try {
		let compiler: string;
		let sdk: string;
		try {
			compiler = (await execute("/usr/bin/xcrun", ["--find", "swiftc"])).stdout.trim();
			sdk = (await execute("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"])).stdout.trim();
		} catch (error) {
			options.signal?.throwIfAborted();
			throw new Error(
				`SwiftUI artifacts require Swift Command Line Tools (xcode-select --install). ${error instanceof Error ? error.message : error}`,
			);
		}
		const toolchain = dirname(dirname(await realpath(compiler)));
		const helper = await readFile(new URL("./swiftui-renderer.swift", import.meta.url), "utf8");
		await writeFile(
			join(directory, "Artifact.swift"),
			`import SwiftUI\nimport AppKit\nimport Foundation\n${source}`,
			{ mode: 0o600 },
		);
		await writeFile(join(directory, "Renderer.swift"), helper, { mode: 0o600 });
		// Pass policies directly, not as files a compiler macro could overwrite.
		const compiled = await execute("/usr/bin/sandbox-exec", [
			"-p",
			profile(directory, toolchain, sdk, true),
			compiler,
			"-sdk",
			sdk,
			"-swift-version",
			"5",
			"-explicit-module-build",
			"-j",
			"2",
			"-parse-as-library",
			"-module-cache-path",
			join(directory, "cache"),
			join(directory, "Artifact.swift"),
			join(directory, "Renderer.swift"),
			"-o",
			join(directory, "preview"),
		]);
		const rendered = await execute(
			"/usr/bin/sandbox-exec",
			[
				"-p",
				profile(directory, toolchain, sdk, false),
				join(directory, "preview"),
				String(width),
				String(height),
				join(directory, "preview.png"),
			],
			15_000,
		);
		// Never follow a generated symlink (or an external hard link) with the unsandboxed
		// parent. Check size before reading so native code cannot force a huge allocation.
		const output = await open(
			join(directory, "preview.png"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		let png: Buffer;
		try {
			const info = await output.stat();
			if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
				throw new Error("SwiftUI renderer output must be a regular PNG up to 16 MiB");
			const buffer = Buffer.alloc(Math.min(info.size + 1, 16 * 1024 * 1024 + 1));
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await output.read(buffer, length, buffer.length - length, null);
				if (!bytesRead) break;
				length += bytesRead;
			}
			png = buffer.subarray(0, length);
		} finally {
			await output.close();
		}
		if (
			png.length > 16 * 1024 * 1024 ||
			png.length < 24 ||
			!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
			png.readUInt32BE(16) !== width ||
			png.readUInt32BE(20) !== height
		)
			throw new Error("SwiftUI renderer did not produce a valid viewport PNG");
		const consoleMessages = [
			...compiled.stderr
				.split("\n")
				.filter(Boolean)
				.map((text) => ({ level: "warning", text })),
			...rendered.stdout
				.split("\n")
				.filter(Boolean)
				.map((text) => ({ level: "log", text })),
			...rendered.stderr
				.split("\n")
				.filter(Boolean)
				.map((text) => ({ level: "warning", text })),
		]
			.slice(0, 100)
			.map((message) => ({ ...message, text: message.text.slice(0, 2000) }));
		return {
			screenshot: { mimeType: "image/png", data: png.toString("base64"), width, height },
			consoleMessages,
			contentHeight: height,
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
