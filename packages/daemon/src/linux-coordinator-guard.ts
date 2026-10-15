/** Runs inside bubblewrap, before importing any worker/package/extension code. Builtins only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, openSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Boundary {
	hostNamespaces: Record<string, string>;
	writable: string[];
	protectedPaths: string[];
	sentinel: string;
}

const config = JSON.parse(process.argv[2]!) as Boundary;
const within = (path: string, parent: string) => {
	const part = relative(parent, path);
	return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};
for (const [namespace, host] of Object.entries(config.hostNamespaces))
	assert.notEqual(readlinkSync(`/proc/self/ns/${namespace}`), host, `${namespace} namespace was not isolated`);
const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /^NoNewPrivs:\s+1$/m);
for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
	assert.match(status, new RegExp(`^${name}:\\s+0+$`, "m"));

const decode = (path: string) =>
	path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
const mounts = readFileSync("/proc/self/mountinfo", "utf8")
	.trim()
	.split("\n")
	.map((line) => {
		const fields = line.split(" ");
		return { id: fields[0]!, path: decode(fields[4]!), readonly: fields[5]!.split(",").includes("ro") };
	});
// mountinfo also lists lower mounts covered by our new /proc and /dev. Resolve the actual
// accessible mount ID with O_PATH (Linux ABI), without opening devices or reading file contents.
function mountId(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, 0x200000); // O_PATH, not exposed by Node's fs.constants.
		const id = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
		assert.ok(id, `No mount ID for ${path}`);
		return id;
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
// Every host-backed mount, including alternate aliases and nested submounts, must be read-only.
// /dev is a new private filesystem. /proc is a fresh PID-scoped, read-only procfs.
for (const mount of mounts) {
	if (!mount.readonly && mountId(mount.path) !== mount.id) continue;
	assert.ok(
		mount.readonly || within(mount.path, "/dev") || config.writable.some((path) => within(mount.path, path)),
		`Unexpected writable mount: ${mount.path}`,
	);
}
for (const path of config.protectedPaths) {
	const id = mountId(path);
	const mount = mounts.find((mount) => mount.id === id);
	assert.ok(mount?.readonly, `Source is not read-only: ${path}`);
}

// The sentinel has ordinary writable host permissions. Only the OS boundary may reject these.
const check = `
const fs = require('node:fs'); const assert = require('node:assert/strict');
for (const path of ${JSON.stringify([config.sentinel, resolve("/proc/self/root", `.${config.sentinel}`)])}) {
  assert.throws(() => fs.writeFileSync(path, 'escape'), {code: 'EROFS'});
  assert.throws(() => fs.chmodSync(path, 0o777), {code: 'EROFS'});
}
`;
assert.throws(() => writeFileSync(config.sentinel, "escape"), { code: "EROFS" });
assert.throws(() => chmodSync(config.sentinel, 0o777), { code: "EROFS" });
execFileSync(process.execPath, ["-e", check], { stdio: "pipe", timeout: 5000 });

if (process.argv[3] === "--probe") process.stdout.write("pilot-linux-isolation-v1\n");
else await import(pathToFileURL(process.argv[3]!).href);
