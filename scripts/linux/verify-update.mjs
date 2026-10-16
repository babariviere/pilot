/** CI-only production-tree update over disposable SSH. No release key or real account. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openUpdateFixtureTerminal } from "./update-terminal.mjs";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Disposable CI fixture only");
const [home, archive, sessionId, helperSource, ...sshArgs] = process.argv.slice(2);
async function child(command, args, input, timeoutMs = 120_000) {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
		const chunks = [];
		let retained = 0;
		proc.stdout.on("data", (chunk) => {
			retained += chunk.length;
			if (retained <= 64 * 1024) chunks.push(chunk);
			else {
				proc.kill();
				reject(new Error("Fixture child output exceeded 64 KiB"));
			}
		});
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error("Fixture child exceeded its bounded deadline"));
		}, timeoutMs);
		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		proc.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(chunks).toString());
			else reject(new Error(`${command}: ${code}`));
		});
		proc.stdin.on("error", () => {});
		proc.stdin.end(input);
	});
}
const ssh = (command) => child("ssh", [...sshArgs, command], undefined, 20_000);
async function until(check, label, diagnostic = async () => "") {
	const deadline = Date.now() + 120_000;
	while (!(await check())) {
		if (Date.now() > deadline) {
			const context = await diagnostic().catch(() => "bounded diagnostics unavailable");
			throw new Error(`Update fixture timed out waiting for ${label}: ${String(context).slice(0, 8000)}`);
		}
		await delay(250);
	}
}
const hello = await (await fetch("http://127.0.0.1:4319/api/hello")).json();
const pid = () => ssh("systemctl --user show pilotd.service --property=MainPID --value");
const oldPid = (await pid()).trim();
const work = await mkdtemp(join(tmpdir(), "pilot-packaged-update-"));
try {
	// A second complete production package, with only its application version changed. It uses the
	// extracted real native runtime/dependencies, not a source checkout or mocked service executable.
	await child("tar", ["-xzf", archive, "-C", work]);
	const runtime = join(work, "runtime"),
		releaseFile = join(runtime, "package.json");
	const release = JSON.parse(await readFile(releaseFile, "utf8"));
	const parts = release.version.split(".");
	release.version = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
	await writeFile(releaseFile, JSON.stringify(release));
	const targetArchive = join(work, "next.tgz");
	await child("tar", ["-czf", targetArchive, "-C", work, "runtime"]);
	const bytes = await readFile(targetArchive),
		digest = createHash("sha256").update(bytes).digest("hex");
	const manifest = JSON.parse(await readFile(join(archive, "../runtime-manifest.json"), "utf8"));
	manifest.version = release.version;
	manifest.tag = `v${release.version}`;
	manifest.archive = { name: "Pilot-linux-x64.tar.gz", size: bytes.length, sha256: digest };
	const exact = Buffer.from(JSON.stringify(manifest)),
		keys = generateKeyPairSync("ed25519");
	const metadata = {
		id: randomUUID(),
		daemonId: hello.daemonId,
		lineageId: hello.lineageId,
		version: release.version,
		archive: digest,
		manifest: exact.toString("base64"),
		signature: sign(null, exact, keys.privateKey).toString("base64"),
		publicKey: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
	};
	const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64");
	const pinned = JSON.stringify({ daemonId: hello.daemonId, lineageId: hello.lineageId });
	const command = `python3 -c "import base64;exec(base64.b64decode('${helperSource}'))" '${digest}' '${bytes.length}' '${pinned}' update '${encoded}'`;

	// A detached workspace PTY and an accepted unfinished upload are genuine production blockers.
	const terminal = await openUpdateFixtureTerminal("http://127.0.0.1:4319", sessionId);
	const image = Buffer.alloc(34);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
	image.write("IHDR", 12);
	image.writeUInt32BE(1, 16);
	image.writeUInt32BE(1, 20);
	const uploadId = randomUUID();
	const upload = request(`http://127.0.0.1:4319/api/attachments/${uploadId}`, {
		method: "PUT",
		headers: {
			"content-length": image.length,
			"x-pilot-attachment": Buffer.from(
				JSON.stringify({
					uploadId,
					sha256: createHash("sha256").update(image).digest("hex"),
					bytes: image.length,
					origin: { hostId: "fixture", daemonId: hello.daemonId, lineageId: hello.lineageId },
				}),
			).toString("base64"),
		},
	});
	const uploadState = { startedAt: Date.now(), response: undefined, error: undefined, closed: false };
	upload.on("response", (response) => {
		uploadState.response = response.statusCode;
		response.resume();
	});
	upload.on("error", (error) => {
		uploadState.error = String(error.code ?? "upload error").slice(0, 80);
	});
	upload.on("close", () => {
		uploadState.closed = true;
	});
	upload.write(image.subarray(0, 33));
	const accepted = JSON.parse(await child("ssh", [...sshArgs, command], bytes));
	assert.equal(accepted.id, metadata.id); // SSH ends here. No connection owns the update.
	assert.equal(accepted.requestConfirmed, true);
	let lastStatus;
	const status = async () => {
		const response = await fetch("http://127.0.0.1:4319/api/runtime-update", { signal: AbortSignal.timeout(5000) });
		const value = await response.json();
		lastStatus = value && {
			id: value.id,
			phase: value.phase,
			revision: value.revision,
			requestConfirmed: value.requestConfirmed,
			detail: String(value.detail ?? "").slice(0, 400),
			blockers: Array.isArray(value.blockers)
				? value.blockers.slice(0, 12).map((item) => ({ kind: item.kind, id: item.id }))
				: [],
		};
		return lastStatus;
	};
	const diagnostic = async () => {
		// Fixed service/fields only, never the raw signed journal, process environment or shell output.
		const owner = await ssh(
			"systemctl --user show pilot-update.service --property=ActiveState,SubState,MainPID,ExecMainStatus,Result,NRestarts; journalctl --user -u pilot-update.service --no-pager -n 12 --output=short",
		);
		return JSON.stringify({
			lastStatus,
			upload: { ...uploadState, ageMs: Date.now() - uploadState.startedAt },
			owner: owner.slice(-6000),
		});
	};
	await until(
		async () => {
			const current = await status();
			return (
				current?.phase === "waiting" &&
				current.blockers.some((item) => item.kind === "transfer") &&
				current.blockers.some((item) => item.kind === "terminal")
			);
		},
		"live terminal and transfer blockers",
		diagnostic,
	);
	assert.equal((await pid()).trim(), oldPid);
	// Kill only the independently owned updater. systemd recovery must retain journal and blockers.
	await ssh("systemctl --user kill --signal=SIGKILL --kill-whom=all pilot-update.service");
	await delay(6000);
	assert.equal((await pid()).trim(), oldPid);
	upload.destroy();
	await terminal.closeShell();
	await until(
		async () => {
			try {
				return (await status())?.phase === "completed";
			} catch {
				return false;
			}
		},
		"completed remote update",
		diagnostic,
	);
	assert.notEqual((await pid()).trim(), oldPid);
	const after = await (await fetch("http://127.0.0.1:4319/api/hello")).json();
	assert.equal(after.daemonVersion, release.version);
	assert.equal(after.daemonId, hello.daemonId);
	assert.equal(after.lineageId, hello.lineageId);
	// A completed transaction stays complete across another user-manager restart (caller exercises it).
	console.log(JSON.stringify({ runtime: `${home}/.local/share/pilot/runtimes/${digest}/runtime`, id: metadata.id }));
} finally {
	await rm(work, { recursive: true, force: true });
}
