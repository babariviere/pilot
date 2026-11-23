import {
	accessSync,
	constants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: node scripts/install-pilot-cli.ts [runtime-directory]";
const checkout = fileURLToPath(new URL("../", import.meta.url));

function readInput(path: string, description: string) {
	try {
		if (statSync(path).isFile()) return readFileSync(path);
	} catch {
		// Report the missing input without touching the installation.
	}
	throw new Error(`Expected readable ${description} at ${path}`);
}

function nodeAt(path: string) {
	try {
		if (statSync(path).isFile()) {
			accessSync(path, constants.X_OK);
			return path;
		}
	} catch {
		// Use a direct error rather than exposing a failed filesystem operation.
	}
	throw new Error(`Expected executable bundled Node at ${path}`);
}

function ensureDirectory(path: string) {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (!lstatSync(path).isDirectory()) {
		throw new Error(`Refusing to use ${path}: it must be a directory, not a symlink or other file.`);
	}
}

function checkLink(path: string, expected: string) {
	const info = lstatSync(path, { throwIfNoEntry: false });
	if (!info) return false;
	if (info.isSymbolicLink() && readlinkSync(path) === expected) return true;
	throw new Error(`Refusing to replace ${path}. Inspect it and move it aside yourself before retrying.`);
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function install(runtime?: string) {
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) throw new Error("Set HOME to your absolute home directory path.");
	const homeDirectory = realpathSync(home);
	if (homeDirectory === parse(homeDirectory).root || !statSync(homeDirectory).isDirectory()) {
		throw new Error("HOME must name a home directory, not the filesystem root or a file.");
	}
	const bundledNode = join(
		runtime ?? join(homeDirectory, "Applications/Pilot.app/Contents/Resources/runtime"),
		"node/bin/node",
	);
	const node = runtime || lstatSync(bundledNode, { throwIfNoEntry: false }) ? nodeAt(bundledNode) : process.execPath;
	const source = runtime ?? checkout;
	const cli = readInput(join(source, "packages/daemon/src/cli/cli.ts"), "Pilot CLI source");
	const skill = readInput(join(source, "packages/kernel/skills/pilot-cli/SKILL.md"), "pilot-cli skill");

	const local = join(homeDirectory, ".local");
	const bin = join(local, "bin");
	const share = join(local, "share");
	const agents = join(homeDirectory, ".agents");
	const skills = join(agents, "skills");
	const managed = join(share, "pilot-agent-cli");
	const current = join(managed, "current");
	const command = join(bin, "pilot");
	const skillDirectory = join(skills, "pilot-cli");
	const commandTarget = join(current, "pilot");
	const skillTarget = join(current, "skill");
	for (const path of [local, bin, agents, skills]) ensureDirectory(path);
	checkLink(command, commandTarget);
	checkLink(skillDirectory, skillTarget);
	for (const path of [share, managed]) ensureDirectory(path);

	// Serialize updates, including first-time publication of the two stable links.
	const lock = join(managed, ".install-lock");
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`Pilot CLI install is locked at ${lock}. Remove only an abandoned lock before retrying.`);
		throw error;
	}
	let release: string | undefined;
	const created: [string, string][] = [];
	try {
		const hasCommand = checkLink(command, commandTarget);
		const hasSkill = checkLink(skillDirectory, skillTarget);
		const previous = lstatSync(current, { throwIfNoEntry: false });
		if (previous && (!previous.isSymbolicLink() || !/^version-[a-zA-Z0-9]{6}$/.test(readlinkSync(current)))) {
			throw new Error(`Refusing to replace unexpected entry at ${current}`);
		}

		release = mkdtempSync(join(managed, "version-"));
		mkdirSync(join(release, "skill"), { mode: 0o700 });
		// .mts is always ESM, including from a home directory with no package.json.
		writeFileSync(join(release, "cli.mts"), cli, { mode: 0o600 });
		writeFileSync(join(release, "skill/SKILL.md"), skill, { mode: 0o600 });
		writeFileSync(
			join(release, "pilot"),
			`#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(join(current, "cli.mts"))} "$@"\n`,
			{ mode: 0o700 },
		);
		if (!hasCommand) {
			symlinkSync(commandTarget, command);
			created.push([command, commandTarget]);
		}
		if (!hasSkill) {
			symlinkSync(skillTarget, skillDirectory);
			created.push([skillDirectory, skillTarget]);
		}
		const next = join(lock, "next");
		symlinkSync(relative(managed, release), next);
		renameSync(next, current);
		release = undefined;
	} catch (error) {
		for (const [path, target] of created.reverse()) if (checkLink(path, target)) rmSync(path);
		throw error;
	} finally {
		if (release) rmSync(release, { recursive: true, force: true });
		const pending = join(lock, "next");
		rmSync(pending, { force: true });
		rmdirSync(lock);
	}
	console.log(`Installed or updated ${command} and ${skillDirectory}/SKILL.md.`);
}

const args = process.argv.slice(2);
try {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(usage);
	} else if (args.length > 1 || args[0]?.startsWith("-")) {
		throw new Error(usage);
	} else {
		install(args[0] ? resolve(args[0]) : undefined);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
