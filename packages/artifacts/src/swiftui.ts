/** Compile untrusted, standalone SwiftUI in a disposable macOS sandbox. */
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactPreview } from "./preview.ts";

const MAX_OUTPUT = 32 * 1024;
// A cold Swift SDK module cache can take minutes on a busy machine.
const TIMEOUT = 300_000;

/** Trusted, prebuilt SDK module caches live outside every sandbox. Untrusted compiles get an APFS clone,
 * so they start warm but can never modify the shared copy. Swift's explicit module cache is only valid at
 * the path where it was built, so compiles run in a few fixed, locked slot directories rather than random
 * temporary ones. */
function cacheRoot(): string {
	return process.env.PILOT_SWIFTUI_CACHE ?? join(homedir(), "Library", "Caches", "Pilot", "swiftui");
}

/** Concurrent compiles across all session workers. More previews at once fall back to a cold compile. */
const SLOTS = 2;

/** Bump when compiler flags or the warm-up program change in a way that invalidates cached modules. */
const CACHE_FORMAT = 1;
const WARMUP_SOURCE =
	'struct ArtifactView: View { var body: some View { VStack { Text("Pilot"); Image(systemName: "star") }.padding() } }';

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

interface Toolchain {
	compiler: string;
	sdk: string;
	/** Toolchain root, readable inside the compile sandbox. */
	root: string;
	/** Identifies compatible module caches and rendered results. */
	key: string;
}

function compileArguments(directory: string, toolchain: Toolchain): string[] {
	// Pass policies directly, not as files a compiler macro could overwrite.
	return [
		"-p",
		profile(directory, toolchain.root, toolchain.sdk, true),
		toolchain.compiler,
		"-sdk",
		toolchain.sdk,
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
	];
}

async function writeSources(directory: string, source: string): Promise<void> {
	const helper = await readFile(new URL("./swiftui-renderer.swift", import.meta.url), "utf8");
	await writeFile(join(directory, "Artifact.swift"), `import SwiftUI\nimport AppKit\nimport Foundation\n${source}`, {
		mode: 0o600,
	});
	await writeFile(join(directory, "Renderer.swift"), helper, { mode: 0o600 });
}

/** APFS clonefile copies are nearly free and private to the sandbox. Without APFS, compile cold. */
function cloneModuleCache(source: string, destination: string): Promise<boolean> {
	return new Promise((resolve) =>
		execFile("/bin/cp", ["-c", "-R", source, destination], { timeout: 60_000 }, (error) => resolve(!error)),
	);
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** An exclusive lock directory, shared by every Pilot process. Locks left by dead processes are reclaimed. */
async function lock(path: string): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await mkdir(path, { mode: 0o700 });
			await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = Number(await readFile(join(path, "pid"), "utf8").catch(() => ""));
			// A lock without a pid may be mid-creation; only a recorded dead owner is stale.
			if (!Number.isSafeInteger(owner) || owner <= 0 || isRunning(owner)) return false;
			await rm(path, { recursive: true, force: true });
		}
	}
	return false;
}

interface Workspace {
	directory: string;
	release(): Promise<void>;
}

async function emptyDirectory(path: string): Promise<string> {
	await rm(path, { recursive: true, force: true });
	await mkdir(path, { recursive: true, mode: 0o700 });
	return realpath(path);
}

/** Lock a slot and give it a private clone of the slot's warm module cache, building that cache first from
 * trusted source (in the same sandbox) if needed. Returns undefined when every slot is busy. */
async function acquireWarmSlot(toolchain: Toolchain): Promise<Workspace | undefined> {
	const base = join(cacheRoot(), toolchain.key);
	await mkdir(base, { recursive: true, mode: 0o700 });
	for (let index = 0; index < SLOTS; index++) {
		const lockPath = join(base, `slot-${index}.lock`);
		if (!(await lock(lockPath))) continue;
		const slot = join(base, `slot-${index}`);
		const release = async () => {
			await rm(slot, { recursive: true, force: true });
			await rm(lockPath, { recursive: true, force: true });
		};
		try {
			const modules = join(base, `slot-${index}.modules`);
			if (!(await stat(modules).catch(() => undefined))?.isDirectory()) {
				const directory = await emptyDirectory(slot);
				try {
					await writeSources(directory, WARMUP_SOURCE);
					await run("/usr/bin/sandbox-exec", compileArguments(directory, toolchain), {
						directory,
						timeout: TIMEOUT,
					});
					await rename(join(directory, "cache"), modules);
				} catch (error) {
					// Without a warm cache this compile is simply cold; a later preview tries again.
					console.warn(`pilot: SwiftUI module cache warm-up failed; compiling cold. ${error}`);
				}
			}
			const directory = await emptyDirectory(slot);
			if ((await stat(modules).catch(() => undefined))?.isDirectory())
				await cloneModuleCache(modules, join(directory, "cache"));
			return { directory, release };
		} catch (error) {
			await release();
			throw error;
		}
	}
	return undefined;
}

async function temporaryWorkspace(): Promise<Workspace> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pilot-swiftui-")));
	return { directory, release: () => rm(directory, { recursive: true, force: true }) };
}

// Preview then publish usually renders identical source twice. Results are pure PNG data.
const RESULT_CACHE_LIMIT = 8;
const results = new Map<string, ArtifactPreview>();

function copyPreview(value: ArtifactPreview): ArtifactPreview {
	return {
		screenshot: { ...value.screenshot },
		consoleMessages: value.consoleMessages.map((message) => ({ ...message })),
		contentHeight: value.contentHeight,
	};
}

/** Test hook: forget rendered results, so integration tests exercise the compiler. */
export function clearSwiftUIResultCache(): void {
	results.clear();
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
	// Toolchain lookups run before a slot is chosen, in a scratch directory.
	let workspace = await temporaryWorkspace();
	let directory = workspace.directory;
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
		const root = dirname(dirname(await realpath(compiler)));
		const helper = await readFile(new URL("./swiftui-renderer.swift", import.meta.url), "utf8");
		const version = (await execute(compiler, ["--version"]).catch(() => ({ stdout: "" }))).stdout;
		const sdkVersion = (
			await execute("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]).catch(() => ({ stdout: "" }))
		).stdout;
		const key = createHash("sha256")
			.update(JSON.stringify([CACHE_FORMAT, compiler, root, sdk, version, sdkVersion, helper]))
			.digest("hex")
			.slice(0, 32);
		const toolchain: Toolchain = { compiler, sdk, root, key };
		const resultKey = createHash("sha256")
			.update(JSON.stringify([key, width, height, source]))
			.digest("hex");
		const cached = results.get(resultKey);
		if (cached) {
			results.delete(resultKey);
			results.set(resultKey, cached);
			return copyPreview(cached);
		}
		const slot = await acquireWarmSlot(toolchain).catch((error: unknown) => {
			console.warn(`pilot: SwiftUI compile slot unavailable; compiling cold. ${error}`);
			return undefined;
		});
		if (slot) {
			await workspace.release();
			workspace = slot;
			directory = slot.directory;
		}
		options.signal?.throwIfAborted();
		await writeSources(directory, source);
		const compiled = await execute("/usr/bin/sandbox-exec", compileArguments(directory, toolchain));
		const rendered = await execute(
			"/usr/bin/sandbox-exec",
			[
				"-p",
				profile(directory, toolchain.root, toolchain.sdk, false),
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
		const preview: ArtifactPreview = {
			screenshot: { mimeType: "image/png", data: png.toString("base64"), width, height },
			consoleMessages,
			contentHeight: height,
		};
		results.set(resultKey, copyPreview(preview));
		while (results.size > RESULT_CACHE_LIMIT) results.delete(results.keys().next().value!);
		return preview;
	} finally {
		await workspace.release();
	}
}
