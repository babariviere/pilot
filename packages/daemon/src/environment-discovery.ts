/**
 * Environment discovery: bounded, read-only reads of a fixed list of repository files, parsed by Pilot itself.
 * Nothing here executes anything (no mise, make, just, go, npm, docker compose or shell): several of those tools
 * run repository content when invoked. Runs in a worker thread; see environment-discovery-worker.ts.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
	EnvironmentDiscovery,
	EnvironmentFinding,
	EnvironmentFindingKind,
	EnvironmentFindingSource,
	EnvironmentStepCandidate,
	EnvironmentSubject,
} from "@pilot/protocol";

export const DISCOVERY_LIMITS = {
	files: 64,
	fileBytes: 256 * 1024,
	totalBytes: 2 * 1024 * 1024,
	/** README and CONTRIBUTING are read only this far. */
	docBytes: 64 * 1024,
	workflows: 32,
	excerpt: 120,
	hintsPerFile: 16,
} as const;

const MISE_FILES = ["mise.toml", ".mise.toml", "mise/config.toml", ".mise/config.toml", ".config/mise.toml"];
/** Ignored local variants that workspace creation copies into new workspaces (workspaces.ts localConfigs). */
export const MISE_LOCAL_FILES = [
	"mise.local.toml",
	".mise.local.toml",
	"mise/config.local.toml",
	".mise/config.local.toml",
];
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
const MAKE_FILES = ["Makefile", "GNUmakefile", "makefile"];
const JUST_FILES = ["justfile", ".justfile", "Justfile"];
const DOC_FILES = ["README.md", "CONTRIBUTING.md"];
const VERSION_FILES: Record<string, string> = {
	".go-version": "go",
	".nvmrc": "node",
	".node-version": "node",
	".python-version": "python",
};

/** The fixed list, in citation priority order: language files first, version managers, then build files. */
export const DISCOVERY_FILES = [
	"go.mod",
	...Object.keys(VERSION_FILES),
	"package.json",
	".tool-versions",
	...MISE_FILES,
	...MISE_LOCAL_FILES,
	...COMPOSE_FILES,
	...MAKE_FILES,
	...JUST_FILES,
	...DOC_FILES,
];

export interface DiscoveredFile {
	path: string;
	text: string;
	sha256: string;
}

export interface DiscoveryRead {
	files: DiscoveredFile[];
	skipped: EnvironmentDiscovery["skipped"];
	truncated: boolean;
	/** Regular root files named .env or .env.*, by name only. Their contents are never opened. */
	localFiles?: string[];
}

export const LOCAL_FILE_PATTERN = /^\.env(?:\.[A-Za-z0-9._-]+)?$/;

/** Root .env files, by name. Only directory entries and lstat are read; at most 32, sorted. */
function localFileCandidates(root: string): string[] {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => LOCAL_FILE_PATTERN.test(entry.name) && entry.isFile())
		.map((entry) => entry.name)
		.sort()
		.slice(0, 32);
}

type Opened = { fd: number; id: string } | { skip: "missing" | "not_regular" };

/** Open a checkout-relative path: no symlink components, regular files only, same inode after opening. */
function openScoped(root: string, path: string): Opened {
	let current = root;
	for (const part of path.split("/")) {
		current = join(current, part);
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(current);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return { skip: "missing" };
			throw error;
		}
		if (info.isSymbolicLink()) return { skip: "not_regular" };
	}
	let fd: number;
	try {
		fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { skip: "missing" };
		if (code === "ELOOP") return { skip: "not_regular" };
		throw error;
	}
	const opened = fstatSync(fd);
	const now = lstatSync(current, { throwIfNoEntry: false });
	if (!opened.isFile() || !now || now.ino !== opened.ino || now.dev !== opened.dev) {
		closeSync(fd);
		return { skip: "not_regular" };
	}
	return { fd, id: `${opened.dev}:${opened.ino}` };
}

/** Workflow files directly under .github/workflows, sorted, without following links. */
function workflowFiles(root: string): { paths: string[]; truncated: boolean } {
	let current = root;
	for (const part of [".github", "workflows"]) {
		current = join(current, part);
		const info = lstatSync(current, { throwIfNoEntry: false });
		if (!info?.isDirectory()) return { paths: [], truncated: false };
	}
	const names = readdirSync(current, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	return {
		paths: names.slice(0, DISCOVERY_LIMITS.workflows).map((name) => `.github/workflows/${name}`),
		truncated: names.length > DISCOVERY_LIMITS.workflows,
	};
}

/** Synchronous by design: call only from a worker thread or tests. */
export function readDiscoveryFiles(checkout: string): DiscoveryRead {
	const root = realpathSync(checkout);
	const workflows = workflowFiles(root);
	const result: DiscoveryRead = { files: [], skipped: [], truncated: workflows.truncated };
	result.localFiles = localFileCandidates(root);
	// Case-insensitive filesystems open Makefile and makefile as one file.
	const seen = new Set<string>();
	let total = 0;
	for (const path of [...DISCOVERY_FILES, ...workflows.paths]) {
		const doc = DOC_FILES.includes(path);
		let opened: Opened;
		try {
			opened = openScoped(root, path);
		} catch {
			result.skipped.push({ path, reason: "unreadable" });
			continue;
		}
		if ("skip" in opened) {
			if (opened.skip !== "missing") result.skipped.push({ path, reason: "not_regular" });
			continue;
		}
		if (seen.has(opened.id)) {
			closeSync(opened.fd);
			continue;
		}
		seen.add(opened.id);
		try {
			const size = fstatSync(opened.fd).size;
			if (!doc && size > DISCOVERY_LIMITS.fileBytes) {
				result.skipped.push({ path, reason: "too_large" });
				result.truncated = true;
				continue;
			}
			const want = Math.min(size, doc ? DISCOVERY_LIMITS.docBytes : DISCOVERY_LIMITS.fileBytes);
			if (result.files.length >= DISCOVERY_LIMITS.files || total + want > DISCOVERY_LIMITS.totalBytes) {
				result.skipped.push({ path, reason: "limit" });
				result.truncated = true;
				continue;
			}
			const buffer = Buffer.alloc(want);
			let read = 0;
			while (read < want) {
				const count = readSync(opened.fd, buffer, read, want - read, read);
				if (!count) break;
				read += count;
			}
			const bytes = buffer.subarray(0, read);
			total += read;
			if (bytes.includes(0)) {
				result.skipped.push({ path, reason: "unreadable" });
				continue;
			}
			result.files.push({
				path,
				text: bytes.toString("utf8"),
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
		} catch {
			result.skipped.push({ path, reason: "unreadable" });
		} finally {
			closeSync(opened.fd);
		}
	}
	return result;
}

// Versions

const ALIASES: Record<string, string> = {
	golang: "go",
	nodejs: "node",
	"node.js": "node",
	postgresql: "postgres",
	python3: "python",
	"golangci-lint-action": "golangci-lint",
};

/** "aqua:golangci/golangci-lint" → "golangci-lint", "golang" → "go". */
export function normalizeSubject(raw: string): string {
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/^["']|["']$/g, "");
	const last = name.split(/[:/]/).filter(Boolean).at(-1) ?? name;
	return ALIASES[last] ?? last;
}

export function normalizeVersion(raw: string): string {
	return raw
		.trim()
		.replace(/^["']|["']$/g, "")
		.replace(/^(?:go|v)(?=\d)/, "");
}

/** Exact needs at least major.minor.patch. Shorter numbers are prefixes, aliases are unknown. */
export function classifyVersion(raw: string): { kind: EnvironmentFindingKind; value?: string; note?: string } {
	const value = normalizeVersion(raw);
	if (!value) return { kind: "unknown" };
	if (/^\d+(?:\.\d+){2,}(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) return { kind: "exact", value };
	if (/^\d+(?:\.\d+)?$/.test(value)) return { kind: "range", value };
	if (/^prefix:/.test(value)) return { kind: "range", value: normalizeVersion(value.slice(7)) };
	if (/^[<>=^~*\d][\s\d.<>=^~|*xX-]*$/.test(value)) return { kind: "range", value };
	return { kind: "unknown", note: `alias ${value.slice(0, 40)}` };
}

function parts(version: string): number[] | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

export function compareVersions(a: string, b: string): number | undefined {
	const left = parts(a);
	const right = parts(b);
	if (!left || !right) return undefined;
	for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
	return 0;
}

/** Prefix match on dot components: "1.23" matches "1.23.4", not "1.230.0". */
function prefixMatch(version: string, prefix: string): boolean {
	const clean = prefix.replace(/(?:\.[xX*])+$/, "");
	return version === clean || version.startsWith(`${clean}.`) || clean === "*" || clean === "";
}

/** npm-style ranges, simplified: ||, space-separated comparators, ^, ~, x and prefixes. undefined: can't tell. */
export function satisfiesRange(version: string, range: string): boolean | undefined {
	const alternatives = range.split("||").map((part) => part.trim());
	let unknown = false;
	for (const alternative of alternatives) {
		const comparators = alternative.split(/[\s,]+/).filter(Boolean);
		let all = true;
		for (const comparator of comparators) {
			const match = /^(>=|<=|>|<|=|\^|~)?\s*v?([\dxX*][\w.*-]*)$/.exec(comparator);
			if (!match) {
				unknown = true;
				all = false;
				break;
			}
			const [, op = "", target = ""] = match;
			const cmp = compareVersions(version, target.replace(/[xX*]/g, "0"));
			if (cmp === undefined && op) {
				unknown = true;
				all = false;
				break;
			}
			const [major = 0, minor = 0] = parts(target) ?? [];
			const ok =
				op === ">="
					? cmp! >= 0
					: op === ">"
						? cmp! > 0
						: op === "<="
							? cmp! <= 0
							: op === "<"
								? cmp! < 0
								: op === "^"
									? cmp! >= 0 && parts(version)![0] === major && (major > 0 || parts(version)![1] === minor)
									: op === "~"
										? cmp! >= 0 && parts(version)![0] === major && parts(version)![1] === minor
										: prefixMatch(version, target);
			if (!ok) {
				all = false;
				break;
			}
		}
		if (all) return true;
	}
	return unknown ? undefined : false;
}

/** Whether an exact version satisfies a constraint finding. undefined when the constraint can't be read. */
export function satisfies(version: string, finding: Pick<EnvironmentFinding, "kind" | "value">): boolean | undefined {
	const value = finding.value;
	if (!value) return undefined;
	if (finding.kind === "minimum") {
		const cmp = compareVersions(version, value);
		return cmp === undefined ? undefined : cmp >= 0;
	}
	if (finding.kind === "major") return parts(version)?.[0] === Number(value);
	if (finding.kind === "hint") {
		if (value.endsWith("+")) return satisfies(version, { kind: "minimum", value: value.slice(0, -1) });
		return prefixMatch(version, value);
	}
	if (finding.kind === "range") return satisfiesRange(version, value);
	if (finding.kind === "exact") return version === value;
	return undefined;
}

// Parsers

class Collector {
	readonly findings: EnvironmentFinding[] = [];
	readonly steps: EnvironmentStepCandidate[] = [];
	private readonly file: DiscoveredFile;
	private readonly lines: string[];
	private hints = 0;

	constructor(file: DiscoveredFile) {
		this.file = file;
		this.lines = file.text.split(/\r?\n/);
	}

	each(visit: (line: string, number: number) => void): void {
		for (let index = 0; index < this.lines.length; index++) visit(this.lines[index]!, index + 1);
	}

	line(number: number): string {
		return this.lines[number - 1] ?? "";
	}

	source(line: number): EnvironmentFindingSource {
		const excerpt = this.line(line).trim();
		return {
			path: this.file.path,
			line,
			excerpt:
				excerpt.length > DISCOVERY_LIMITS.excerpt ? `${excerpt.slice(0, DISCOVERY_LIMITS.excerpt - 1)}…` : excerpt,
			sha256: this.file.sha256,
		};
	}

	add(subject: string, kind: EnvironmentFindingKind, value: string | undefined, line: number, note?: string): void {
		if (!subject || subject.length > 64) return;
		if (kind === "hint" && ++this.hints > DISCOVERY_LIMITS.hintsPerFile) return;
		this.findings.push({
			subject,
			kind,
			...(value ? { value } : {}),
			source: this.source(line),
			...(note ? { note } : {}),
		});
	}

	version(subject: string, raw: string, line: number, note?: string): void {
		const classified = classifyVersion(raw);
		const notes = [note, classified.note].filter(Boolean).join("; ");
		this.add(subject, classified.kind, classified.value, line, notes || undefined);
	}

	step(id: string, argv: string[], purpose: "setup" | "check", line: number): void {
		this.steps.push({
			id,
			title: argv.join(" "),
			run: { argv },
			purpose,
			proposed: false,
			source: this.source(line),
		});
	}
}

function stripComment(line: string): string {
	return line.replace(/(^|\s)#.*$/, "").trim();
}

function parseToolVersions(c: Collector): void {
	c.each((raw, line) => {
		const [tool, first, ...rest] = stripComment(raw).split(/\s+/);
		if (!tool || !first) return;
		c.version(
			normalizeSubject(tool),
			first,
			line,
			rest.length ? `also lists ${rest.join(", ").slice(0, 60)}` : undefined,
		);
	});
}

/** The [tools] table of a mise config: strings, arrays, inline tables with version, and [tools.<name>] tables. */
function parseMise(c: Collector): void {
	let section = "";
	c.each((raw, line) => {
		const text = stripComment(raw);
		const header = /^\[\s*([^\]]+?)\s*\]$/.exec(text);
		if (header) {
			section = header[1]!.replace(/\s/g, "");
			return;
		}
		const assignment = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.:/@-]+)\s*=\s*(.+)$/.exec(text);
		if (!assignment) return;
		const [, key = "", value = ""] = assignment;
		if (section === "tools") {
			const subject = normalizeSubject(key);
			const array = /^\[\s*["']([^"']*)["']/.exec(value);
			const table = /\bversion\s*=\s*["']([^"']*)["']/.exec(value);
			const string = /^["']([^"']*)["']/.exec(value);
			const version = array?.[1] ?? (value.startsWith("{") ? table?.[1] : string?.[1]);
			if (version !== undefined) c.version(subject, version, line);
		} else if (section.startsWith("tools.") && key === "version") {
			const string = /^["']([^"']*)["']/.exec(value);
			if (string) c.version(normalizeSubject(section.slice(6).replace(/^["']|["']$/g, "")), string[1]!, line);
		}
	});
}

function parseGoMod(c: Collector): void {
	const requires = new Map<string, string>();
	const tools: { path: string; line: number }[] = [];
	let block = "";
	c.each((raw, line) => {
		const text = raw.replace(/\/\/.*$/, "").trim();
		if (block) {
			if (text === ")") block = "";
			else if (block === "require") {
				const [module, version] = text.split(/\s+/);
				if (module && version) requires.set(module, version);
			} else if (block === "tool" && text) tools.push({ path: text, line });
			return;
		}
		const open = /^(require|tool)\s*\($/.exec(text);
		if (open) {
			block = open[1]!;
			return;
		}
		let match = /^go\s+(\S+)$/.exec(text);
		if (match) c.add("go", "minimum", normalizeVersion(match[1]!), line, "minimum toolchain");
		match = /^toolchain\s+(\S+)$/.exec(text);
		if (match) c.version("go", match[1]!, line);
		match = /^require\s+(\S+)\s+(\S+)$/.exec(text);
		if (match) requires.set(match[1]!, match[2]!);
		match = /^tool\s+(\S+)$/.exec(text);
		if (match) tools.push({ path: match[1]!, line });
	});
	for (const tool of tools) {
		const name = tool.path
			.split("/")
			.filter((part) => !/^v\d+$/.test(part))
			.at(-1);
		if (!name) continue;
		let module = "";
		for (const candidate of requires.keys())
			if ((tool.path === candidate || tool.path.startsWith(`${candidate}/`)) && candidate.length > module.length)
				module = candidate;
		const version = module ? requires.get(module) : undefined;
		if (version) c.version(normalizeSubject(name), version, tool.line, "provided by go tool");
		else c.add(normalizeSubject(name), "unknown", undefined, tool.line, "provided by go tool");
	}
}

function parseVersionFile(c: Collector, subject: string): void {
	let done = false;
	c.each((raw, line) => {
		const text = stripComment(raw);
		if (done || !text) return;
		done = true;
		c.version(subject, text, line);
	});
}

function lineOf(c: Collector, pattern: RegExp): number {
	let found = 1;
	let seen = false;
	c.each((raw, line) => {
		if (!seen && pattern.test(raw)) {
			found = line;
			seen = true;
		}
	});
	return found;
}

function parsePackageJson(c: Collector, text: string): void {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return;
	}
	if (!json || typeof json !== "object") return;
	const pkg = json as { packageManager?: unknown; engines?: Record<string, unknown> };
	if (typeof pkg.packageManager === "string") {
		const match = /^([a-z0-9-]+)@([^+]+)(\+.*)?$/.exec(pkg.packageManager);
		if (match)
			c.version(
				normalizeSubject(match[1]!),
				match[2]!,
				lineOf(c, /"packageManager"/),
				match[3] ? "integrity hash pinned" : undefined,
			);
	}
	if (pkg.engines && typeof pkg.engines === "object")
		for (const [engine, range] of Object.entries(pkg.engines)) {
			if (typeof range !== "string" || !["node", "pnpm", "npm", "yarn", "bun"].includes(engine)) continue;
			const line = lineOf(c, new RegExp(`"${engine}"\\s*:`));
			const minimum = /^>=\s*v?(\d+(?:\.\d+){0,2})$/.exec(range.trim());
			if (minimum) c.add(engine, "minimum", minimum[1], line, "engines");
			else c.version(engine, range, line, "engines");
		}
}

/** Database images only. Values, environment and interpolation are never evaluated. */
function imageFinding(c: Collector, image: string, line: number, hint: boolean): void {
	const clean = image.replace(/@sha256:[0-9a-f]+$/, "");
	// A variable never resolves here; read the name before it.
	const literal = clean.split("${")[0]!;
	const slash = literal.lastIndexOf("/");
	const colon = literal.indexOf(":", slash + 1);
	const name = (colon > slash ? clean.slice(0, colon) : clean).split("/").at(-1)?.toLowerCase() ?? "";
	const tag = colon > slash ? clean.slice(colon + 1) : "";
	if (!["postgres", "postgresql", "postgis"].includes(name)) return;
	// Postgres and PostGIS tags both start with the Postgres major: "16-alpine", "16.4", "16-3.4".
	const major = clean.includes("${") ? undefined : /^(\d+)(?:[.-]|$)/.exec(tag)?.[1];
	if (major) c.add("postgres", hint ? "hint" : "major", major, line, name === "postgis" ? "PostGIS image" : undefined);
	else if (!hint) {
		const note = clean.includes("${") ? "image uses a variable" : tag ? `tag ${tag.slice(0, 40)}` : "no tag";
		c.add("postgres", "unknown", undefined, line, note);
	}
}

function parseCompose(c: Collector): void {
	let inServices = false;
	c.each((raw, line) => {
		if (/^\S/.test(raw)) inServices = /^services:\s*(#.*)?$/.test(raw);
		if (!inServices) return;
		const image = /^\s+image:\s*["']?([^"'\s#]+)/.exec(raw);
		if (image) imageFinding(c, image[1]!, line, false);
	});
}

const SETUP_TARGETS = ["setup", "bootstrap", "deps", "dependencies", "tools", "install-tools", "migrate", "db-migrate"];
const CHECK_TARGETS = ["lint", "test", "check"];

function targetStep(c: Collector, runner: "make" | "just", target: string, line: number): void {
	if (SETUP_TARGETS.includes(target)) c.step(target, [runner, target], "setup", line);
	else if (CHECK_TARGETS.includes(target)) c.step(target, [runner, target], "check", line);
}

function versionVariable(c: Collector, name: string, value: string, line: number): void {
	const literal = value.trim().replace(/^["']|["']$/g, "");
	if (!/^v?\d/.test(literal) || /[$(`]/.test(literal)) return;
	c.version(normalizeSubject(name.toLowerCase().replace(/_/g, "-")), literal, line, `${name}_VERSION`);
}

function parseMakefile(c: Collector): void {
	const seen = new Set<string>();
	c.each((raw, line) => {
		const variable = /^([A-Z][A-Z0-9_]*)_VERSION\s*(?:\?|:|::|\+)?=\s*([^#]*)/.exec(raw);
		if (variable) return versionVariable(c, variable[1]!, variable[2]!, line);
		const target = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(raw);
		if (target && !target[1]!.startsWith(".") && !seen.has(target[1]!)) {
			seen.add(target[1]!);
			targetStep(c, "make", target[1]!, line);
		}
	});
}

function parseJustfile(c: Collector): void {
	const seen = new Set<string>();
	c.each((raw, line) => {
		const variable = /^([A-Za-z][A-Za-z0-9_]*)_(?:VERSION|version)\s*:=\s*(.*)$/.exec(raw);
		if (variable) return versionVariable(c, variable[1]!.toUpperCase(), variable[2]!, line);
		const recipe = /^@?([A-Za-z0-9_-]+)(?:\s+[^:=]*)?:(?!=)/.exec(raw);
		if (!recipe || ["set", "alias", "export", "import", "mod"].includes(recipe[1]!) || seen.has(recipe[1]!)) return;
		seen.add(recipe[1]!);
		targetStep(c, "just", recipe[1]!, line);
	});
}

const DOC_HINT =
	/\b(Go|Golang|Node(?:\.js|JS)?|Python|PostgreSQL|Postgres|pnpm)\s+(?:version\s+)?v?(\d+(?:\.\d+){0,2})(\+|\s+or\s+(?:later|newer|higher|above))?/g;

function parseDoc(c: Collector): void {
	const seen = new Set<string>();
	c.each((raw, line) => {
		for (const match of raw.matchAll(DOC_HINT)) {
			const subject = normalizeSubject(match[1]!);
			if (seen.has(subject)) continue;
			seen.add(subject);
			c.add(subject, "hint", `${match[2]}${match[3] ? "+" : ""}`, line);
		}
	});
}

function parseWorkflow(c: Collector): void {
	let action = "";
	let actionLine = 0;
	c.each((raw, line) => {
		const uses = /uses:\s*["']?([\w.-]+\/[\w.-]+)@/.exec(raw);
		if (uses) {
			action = uses[1]!;
			actionLine = line;
		}
		const setup = /\b(go|node|python)-version:\s*["']?(v?\d[^"'\s#]*)/.exec(raw);
		if (setup) c.add(normalizeSubject(setup[1]!), "hint", normalizeVersion(setup[2]!), line);
		const version = /^\s*version:\s*["']?(v?\d[^"'\s#]*)/.exec(raw);
		if (version && line - actionLine <= 8) {
			if (action === "golangci/golangci-lint-action")
				c.add("golangci-lint", "hint", normalizeVersion(version[1]!), line);
			if (action === "pnpm/action-setup") c.add("pnpm", "hint", normalizeVersion(version[1]!), line);
		}
		const image = /^\s*image:\s*["']?([^"'\s#]+)/.exec(raw);
		if (image) imageFinding(c, image[1]!, line, true);
	});
}

export function parseDiscoveredFile(file: DiscoveredFile): Collector {
	const c = new Collector(file);
	const { path } = file;
	if (path === ".tool-versions") parseToolVersions(c);
	else if (MISE_FILES.includes(path) || MISE_LOCAL_FILES.includes(path)) parseMise(c);
	else if (path === "go.mod") parseGoMod(c);
	else if (VERSION_FILES[path]) parseVersionFile(c, VERSION_FILES[path]);
	else if (path === "package.json") parsePackageJson(c, file.text);
	else if (COMPOSE_FILES.includes(path)) parseCompose(c);
	else if (MAKE_FILES.includes(path)) parseMakefile(c);
	else if (JUST_FILES.includes(path)) parseJustfile(c);
	else if (DOC_FILES.includes(path)) parseDoc(c);
	else if (path.startsWith(".github/workflows/")) parseWorkflow(c);
	return c;
}

// Resolution

const SERVICES = new Set(["postgres"]);
const SOURCE_ORDER = new Map(DISCOVERY_FILES.map((path, index) => [path, index]));

function citation(finding: EnvironmentFinding): string {
	return `${finding.source.path}:${finding.source.line}`;
}

function describe(finding: EnvironmentFinding): string {
	const where = finding.source.path.startsWith(".github/") ? "CI" : finding.source.path;
	return `${where} mentions ${finding.value ?? "an unknown version"}`;
}

export function resolveSubject(subject: string, findings: EnvironmentFinding[]): EnvironmentSubject {
	const category = SERVICES.has(subject) ? "service" : "tool";
	const sorted = [...findings].sort(
		(a, b) =>
			(SOURCE_ORDER.get(a.source.path) ?? SOURCE_ORDER.size) -
				(SOURCE_ORDER.get(b.source.path) ?? SOURCE_ORDER.size) ||
			a.source.path.localeCompare(b.source.path) ||
			a.source.line - b.source.line,
	);
	const base: EnvironmentSubject = {
		subject,
		category,
		status: "needs_version",
		findings: sorted,
		notes: [],
		...(sorted.some((finding) => finding.note === "provided by go tool") ? { goTool: true } : {}),
	};
	const declared = sorted.filter((finding) => finding.kind !== "hint");
	const hints = sorted.filter((finding) => finding.kind === "hint");
	if (!declared.length) return { ...base, status: "hint_only" };
	const exact = declared.filter((finding) => finding.kind === (category === "service" ? "major" : "exact"));
	const values = [...new Set(exact.map((finding) => finding.value!))];
	if (values.length > 1) return { ...base, status: "conflict" };
	if (!values.length) return base;
	const value = values[0]!;
	const constraints = declared.filter((finding) => !exact.includes(finding) && finding.kind !== "unknown");
	const notes: string[] = [];
	for (const constraint of constraints) {
		const ok = category === "service" ? constraint.value === value : satisfies(value, constraint);
		if (ok === false) return { ...base, status: "conflict" };
		if (ok === undefined) notes.push(`Couldn't check ${constraint.value} from ${citation(constraint)}`);
	}
	for (const unknown of declared.filter((finding) => finding.kind === "unknown"))
		notes.push(`Couldn't check ${citation(unknown)}${unknown.note ? ` (${unknown.note})` : ""}`);
	for (const hint of hints) {
		const ok =
			category === "service"
				? hint.value?.endsWith("+")
					? Number(value) >= Number(hint.value.slice(0, -1))
					: hint.value === value
				: satisfies(value, hint);
		if (ok === false) notes.push(describe(hint));
	}
	const chosen = exact[0]!;
	return {
		...base,
		status: "proposed",
		value,
		from: { path: chosen.source.path, line: chosen.source.line },
		notes,
	};
}

export function resolveDiscovery(projectId: string, read: DiscoveryRead, now = Date.now()): EnvironmentDiscovery {
	const findings: EnvironmentFinding[] = [];
	const steps: EnvironmentStepCandidate[] = [];
	for (const file of read.files) {
		const collected = parseDiscoveredFile(file);
		findings.push(...collected.findings);
		steps.push(...collected.steps);
	}
	const bySubject = new Map<string, EnvironmentFinding[]>();
	for (const finding of findings) bySubject.set(finding.subject, [...(bySubject.get(finding.subject) ?? []), finding]);
	const subjects = [...bySubject.entries()]
		.map(([subject, list]) => resolveSubject(subject, list))
		.sort((a, b) =>
			a.category === b.category ? a.subject.localeCompare(b.subject) : a.category === "tool" ? -1 : 1,
		);
	const uniqueSteps: EnvironmentStepCandidate[] = [];
	for (const step of steps)
		if (!uniqueSteps.some((existing) => existing.id === step.id && existing.purpose === step.purpose))
			uniqueSteps.push(step);
	const proposed = ["setup", "bootstrap", "deps"]
		.map((id) => uniqueSteps.find((step) => step.id === id && step.purpose === "setup"))
		.find(Boolean);
	if (proposed) proposed.proposed = true;
	return {
		projectId,
		computedAt: now,
		subjects,
		steps: uniqueSteps,
		sources: read.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
		skipped: read.skipped,
		truncated: read.truncated,
		localFiles: read.localFiles ?? [],
	};
}
