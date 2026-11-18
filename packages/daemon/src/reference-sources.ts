/** Exact pinned dependency sources, resolved from a project's lock files. Paths come from lock files, never model input. */
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ReferenceSource } from "@pilot/kernel";

const run = promisify(execFile);
// Disk and daemon time: lock files above this are not parsed. A large Cargo.lock is about 300 KB.
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const GO_FILES = ["go.mod"];
const CARGO_FILES = ["Cargo.lock"];
const NODE_FILES = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
];

export interface GoRequirement {
	path: string;
	version: string;
	indirect: boolean;
}

/** Go's module cache case escaping: each upper-case letter becomes "!" and its lower-case form. */
export function escapeGoPath(path: string): string {
	return path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

const GO_MODULE = /^[A-Za-z0-9][A-Za-z0-9._~+-]*(?:\/[A-Za-z0-9._~+-]+)*$/;
const GO_VERSION = /^v\d[0-9A-Za-z.+-]*$/;
function goModule(path: string | undefined): path is string {
	return !!path && GO_MODULE.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}

function goTokens(line: string): { tokens: string[]; indirect: boolean } {
	const comment = line.indexOf("//");
	const indirect = comment >= 0 && /^\/\/\s*indirect\b/.test(line.slice(comment).trim());
	const code = comment >= 0 ? line.slice(0, comment) : line;
	return {
		tokens: code
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((token) => token.replace(/^"(.*)"$/, "$1")),
		indirect,
	};
}

/** require and module-path replace directives. Local directory replacements are skipped: they are not cache entries. */
export function parseGoMod(text: string): GoRequirement[] {
	const requires: GoRequirement[] = [];
	const replaces: ReturnType<typeof replacement>[] = [];
	const directive = (verb: string, words: string[], indirect: boolean) => {
		if (verb === "require" && goModule(words[0]) && GO_VERSION.test(words[1] ?? ""))
			requires.push({ path: words[0], version: words[1]!, indirect });
		if (verb === "replace" && words.includes("=>")) replaces.push(replacement(words));
	};
	let block: string | undefined;
	for (const raw of text.split("\n")) {
		const { tokens, indirect } = goTokens(raw);
		if (!tokens.length) continue;
		if (block) {
			if (tokens[0] === ")") block = undefined;
			else directive(block, tokens, indirect);
			continue;
		}
		const [verb, ...words] = tokens;
		if (words[0] === "(") block = verb;
		else directive(verb!, words, indirect);
	}
	const resolved: GoRequirement[] = [];
	for (const requirement of requires) {
		const rule =
			replaces.find((r) => r.from === requirement.path && r.fromVersion === requirement.version) ??
			replaces.find((r) => r.from === requirement.path && !r.fromVersion);
		if (!rule) resolved.push(requirement);
		else if (rule.to && rule.toVersion) resolved.push({ ...requirement, path: rule.to, version: rule.toVersion });
	}
	return resolved;
}

function replacement(words: string[]): { from: string; fromVersion?: string; to?: string; toVersion?: string } {
	const arrow = words.indexOf("=>");
	const [from, fromVersion] = words.slice(0, arrow);
	const [to, toVersion] = words.slice(arrow + 1);
	return {
		from: from ?? "",
		...(fromVersion && GO_VERSION.test(fromVersion) ? { fromVersion } : {}),
		// A path without a version is a local directory, not a module cache entry.
		...(goModule(to) && toVersion && GO_VERSION.test(toVersion) ? { to, toVersion } : {}),
	};
}

export interface CargoPackage {
	name: string;
	version: string;
}

const CARGO_NAME = /^[A-Za-z0-9_-]+$/;
const CARGO_VERSION = /^[0-9A-Za-z.+-]+$/;

/** Registry packages that workspace members (packages without a source) depend on directly. */
export function parseCargoLock(text: string): CargoPackage[] {
	type Entry = { name?: string; version?: string; source?: string; dependencies: string[] };
	const packages: Entry[] = [];
	let current: Entry | undefined;
	let list = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (list && current) {
			if (line.startsWith("]")) list = false;
			else {
				const value = /^"([^"]*)"/.exec(line)?.[1];
				if (value) current.dependencies.push(value);
			}
			continue;
		}
		if (line.startsWith("[")) {
			current = line === "[[package]]" ? { dependencies: [] } : undefined;
			if (current) packages.push(current);
			continue;
		}
		if (!current) continue;
		const field = /^(name|version|source)\s*=\s*"([^"]*)"/.exec(line);
		if (field) current[field[1] as "name" | "version" | "source"] = field[2];
		const dependencies = /^dependencies\s*=\s*\[(.*)$/.exec(line);
		if (dependencies) {
			for (const match of dependencies[1]!.matchAll(/"([^"]*)"/g)) current.dependencies.push(match[1]!);
			list = !dependencies[1]!.includes("]");
		}
	}
	const registry = packages.filter(
		(p) =>
			/^(?:registry|sparse)\+/.test(p.source ?? "") &&
			CARGO_NAME.test(p.name ?? "") &&
			CARGO_VERSION.test(p.version ?? ""),
	);
	const found = new Map<string, CargoPackage>();
	for (const member of packages.filter((p) => p.name && !p.source))
		for (const dependency of member.dependencies) {
			const [name, version] = dependency.split(" ");
			const match = registry.find((p) => p.name === name && (!version || p.version === version));
			if (match) found.set(`${match.name}@${match.version}`, { name: match.name!, version: match.version! });
		}
	return [...found.values()];
}

function containedIn(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A real directory inside root after resolving links, or undefined. */
async function directoryIn(root: string, path: string): Promise<string | undefined> {
	try {
		const real = await realpath(path);
		if (!(await lstat(real)).isDirectory()) return undefined;
		return containedIn(await realpath(root), real) ? real : undefined;
	} catch {
		return undefined;
	}
}

async function smallText(path: string): Promise<string | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return undefined;
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function signature(root: string, names: string[]): Promise<string> {
	const parts: string[] = [];
	for (const name of names) {
		const stat = await lstat(join(root, name)).catch(() => undefined);
		parts.push(stat ? `${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : `${name}:-`);
	}
	return parts.join("|");
}

export interface DependencyLocations {
	/** $(go env GOMODCACHE). Found once per daemon when omitted. */
	goModCache?: string;
	/** CARGO_HOME, default ~/.cargo. */
	cargoHome?: string;
}

/**
 * Caches each project's resolution until one of its lock files changes (inode, size or mtime).
 * A call costs a few lstat calls; the full resolution runs only after a lock-file change.
 */
export class DependencySources {
	private readonly cache = new Map<string, { signature: string; result: Promise<ReferenceSource[]> }>();
	private goCache: Promise<string> | undefined;
	private readonly locations: DependencyLocations;
	constructor(locations: DependencyLocations = {}) {
		this.locations = locations;
	}

	/** lockRoot holds go.mod and Cargo.lock; installRoot holds package.json and node_modules. */
	async resolve(lockRoot: string, installRoot: string): Promise<ReferenceSource[]> {
		const key = `${lockRoot}\0${installRoot}`;
		const current = `${await signature(lockRoot, [...GO_FILES, ...CARGO_FILES])}#${await signature(installRoot, NODE_FILES)}`;
		const cached = this.cache.get(key);
		if (cached?.signature === current) return cached.result;
		const result = this.resolveNow(lockRoot, installRoot);
		this.cache.set(key, { signature: current, result });
		result.catch(() => {
			if (this.cache.get(key)?.result === result) this.cache.delete(key);
		});
		return result;
	}

	private async resolveNow(lockRoot: string, installRoot: string): Promise<ReferenceSource[]> {
		const [go, cargo, node] = await Promise.all([this.go(lockRoot), this.cargo(lockRoot), this.node(installRoot)]);
		return [...go, ...cargo, ...node];
	}

	private goModCache(): Promise<string> {
		if (this.locations.goModCache) return Promise.resolve(this.locations.goModCache);
		this.goCache ??= (async () => {
			if (process.env.GOMODCACHE) return process.env.GOMODCACHE;
			try {
				// No go.mod in cwd and a local toolchain only: never downloads a toolchain.
				const { stdout } = await run("go", ["env", "GOMODCACHE"], {
					cwd: tmpdir(),
					timeout: 5000,
					env: { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "" },
				});
				if (isAbsolute(stdout.trim())) return stdout.trim();
			} catch {}
			return join(process.env.GOPATH?.split(":")[0] || join(homedir(), "go"), "pkg", "mod");
		})();
		return this.goCache;
	}

	private async go(root: string): Promise<ReferenceSource[]> {
		const text = await smallText(join(root, "go.mod"));
		if (!text) return [];
		const cache = await this.goModCache();
		const sources: ReferenceSource[] = [];
		for (const module of parseGoMod(text)) {
			const path = await directoryIn(
				cache,
				join(cache, `${escapeGoPath(module.path)}@${escapeGoPath(module.version)}`),
			);
			if (path)
				sources.push({
					kind: "dependency",
					name: module.path,
					version: module.version,
					...(module.indirect ? { indirect: true as const } : {}),
					path,
				});
		}
		return sources;
	}

	private async cargo(root: string): Promise<ReferenceSource[]> {
		const text = await smallText(join(root, "Cargo.lock"));
		if (!text) return [];
		const registry = join(
			this.locations.cargoHome ?? process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
			"registry",
			"src",
		);
		const indexes = await readdir(registry).catch(() => [] as string[]);
		const sources: ReferenceSource[] = [];
		for (const crate of parseCargoLock(text))
			for (const index of indexes) {
				const path = await directoryIn(registry, join(registry, index, `${crate.name}-${crate.version}`));
				if (!path) continue;
				sources.push({ kind: "dependency", name: crate.name, version: crate.version, path });
				break;
			}
		return sources;
	}

	/** Declared package.json dependencies as installed under node_modules, only when a lock file pins them. */
	private async node(root: string): Promise<ReferenceSource[]> {
		const locked = await Promise.all(
			NODE_FILES.slice(1).map((name) => lstat(join(root, name)).catch(() => undefined)),
		);
		if (!locked.some(Boolean)) return [];
		const manifest = await smallText(join(root, "package.json"));
		if (!manifest) return [];
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(manifest);
		} catch {
			return [];
		}
		const names = new Set<string>();
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
			const value = parsed[field];
			if (value && typeof value === "object") for (const name of Object.keys(value)) names.add(name);
		}
		const modules = join(root, "node_modules");
		const sources: ReferenceSource[] = [];
		for (const name of names) {
			if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)) continue;
			// Workspace links point back into the project, which chats can already read.
			const path = await directoryIn(modules, join(modules, name));
			if (!path) continue;
			try {
				const installed = JSON.parse((await smallText(join(path, "package.json"))) ?? "");
				if (installed.name === name && typeof installed.version === "string")
					sources.push({ kind: "dependency", name, version: installed.version, path });
			} catch {}
		}
		return sources;
	}
}
