import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	DISCOVERY_FILES,
	DISCOVERY_LIMITS,
	MISE_LOCAL_FILES,
	parseDiscoveredFile,
	readDiscoveryFiles,
	resolveDiscovery,
	satisfies,
	satisfiesRange,
} from "./environment-discovery.ts";
import { localConfigs } from "./workspaces.ts";

async function checkout(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pilot-environment-discovery-"));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return root;
}

function discover(root: string) {
	return resolveDiscovery("p1", readDiscoveryFiles(root), 1);
}

function parse(path: string, text: string) {
	return parseDiscoveredFile({ path, text, sha256: "0".repeat(64) });
}

/** The Go service worked example from docs/environment-setup.md, section 11. */
export const goServiceCheckout = {
	"go.mod": "module github.com/acme/orders\n\ngo 1.22.0\n\ntoolchain go1.23.4\n\nrequire github.com/lib/pq v1.10.9\n",
	".tool-versions": "golang 1.23.4\ngolangci-lint 1.61.0\n",
	Makefile: [
		"GOLANGCI_LINT_VERSION ?= v1.60.3",
		"",
		".PHONY: setup migrate lint test",
		"setup:",
		"\t./scripts/bootstrap.sh",
		"migrate:",
		"\tgo run ./cmd/migrate up",
		"lint:",
		"\tgolangci-lint run ./...",
		"test:",
		"\tgo test ./...",
		"",
	].join("\n"),
	"scripts/bootstrap.sh": "#!/bin/sh\ngo mod download\nmake migrate\n",
	"compose.yaml": [
		"services:",
		"  db:",
		"    image: postgres:16-alpine",
		"    ports:",
		'      - "5432:5432"',
		"    environment:",
		"      POSTGRES_DB: orders",
		"      POSTGRES_PASSWORD: hunter2-secret",
		"",
	].join("\n"),
	"README.md": "# Orders\n\nRequires Go 1.22+ and PostgreSQL 15 or later.\n",
	".env": "STRIPE_KEY=sk_live_never_read\n",
};

test("the Go service worked example resolves as designed", async (t) => {
	const root = await checkout(goServiceCheckout);
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = discover(root);
	const subject = (name: string) => result.subjects.find((entry) => entry.subject === name)!;

	const go = subject("go");
	assert.equal(go.status, "proposed");
	assert.equal(go.value, "1.23.4");
	assert.deepEqual(go.from, { path: "go.mod", line: 5 });
	assert.deepEqual(go.notes, [], "README's Go 1.22+ agrees");
	assert.deepEqual(
		go.findings.map((finding) => [finding.source.path, finding.source.line, finding.kind, finding.value]),
		[
			["go.mod", 3, "minimum", "1.22.0"],
			["go.mod", 5, "exact", "1.23.4"],
			[".tool-versions", 1, "exact", "1.23.4"],
			["README.md", 3, "hint", "1.22+"],
		],
	);

	const lint = subject("golangci-lint");
	assert.equal(lint.status, "conflict");
	assert.equal(lint.value, undefined);
	assert.deepEqual(
		lint.findings.map((finding) => [`${finding.source.path}:${finding.source.line}`, finding.value]),
		[
			[".tool-versions:2", "1.61.0"],
			["Makefile:1", "1.60.3"],
		],
	);

	const postgres = subject("postgres");
	assert.equal(postgres.category, "service");
	assert.equal(postgres.status, "proposed");
	assert.equal(postgres.value, "16");
	assert.deepEqual(postgres.from, { path: "compose.yaml", line: 3 });
	assert.deepEqual(postgres.notes, [], "README's PostgreSQL 15 or later agrees");

	assert.deepEqual(
		result.steps.map((step) => [step.id, step.purpose, step.proposed, step.run.argv.join(" ")]),
		[
			["setup", "setup", true, "make setup"],
			["migrate", "setup", false, "make migrate"],
			["lint", "check", false, "make lint"],
			["test", "check", false, "make test"],
		],
	);
	assert.deepEqual(
		result.sources.map((source) => source.path),
		["go.mod", ".tool-versions", "compose.yaml", "Makefile", "README.md"],
	);
	assert.equal(result.truncated, false);
	assert.doesNotMatch(
		JSON.stringify(result),
		/hunter2|bootstrap\.sh"|sk_live/,
		"values, scripts and local files are never read",
	);
	assert.deepEqual(result.localFiles, [".env"], "local files are suggested by name only");
	const goMod = result.sources.find((source) => source.path === "go.mod")!;
	assert.match(goMod.sha256, /^[0-9a-f]{64}$/);
});

test("discovery never executes repository content", async (t) => {
	const root = await checkout({
		Makefile: "GO_VERSION := $(shell touch pwned-make && echo 1.23.4)\nsetup:\n\ttouch pwned\n",
		"mise.toml": '[env]\n_.source = "./pwn.sh"\n[hooks]\nenter = "touch pwned-mise"\n[tools]\ngo = "1.23.4"\n',
		"pwn.sh": "touch pwned-source\n",
		"compose.yaml": "services:\n  db:\n    image: postgres:${PG_TAG:-16}\n",
	});
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = discover(root);
	for (const name of ["pwned", "pwned-make", "pwned-mise", "pwned-source"])
		await assert.rejects(stat(join(root, name)), /ENOENT/, name);
	const go = result.subjects.find((entry) => entry.subject === "go")!;
	assert.deepEqual(
		go.findings.map((finding) => finding.source.path),
		["mise.toml"],
		"a computed Makefile version is not a literal pin",
	);
	const postgres = result.subjects.find((entry) => entry.subject === "postgres")!;
	assert.equal(postgres.status, "needs_version");
	assert.equal(postgres.findings[0]!.note, "image uses a variable");
	for (const file of ["environment-discovery.ts", "environment-discovery-worker.ts"])
		assert.doesNotMatch(
			await readFile(new URL(`./${file}`, import.meta.url), "utf8"),
			/child_process|\bspawn|\bexecFile|subprocess/,
			file,
		);
});

test("reads are bounded and refuse links and non-regular files", async (t) => {
	const outside = await checkout({ "go.mod": "go 1.22.0\ntoolchain go1.30.0\n" });
	const big = "x".repeat(250 * 1024);
	const root = await checkout({
		Makefile: "x".repeat(DISCOVERY_LIMITS.fileBytes + 1),
		"README.md": `Requires Go 1.22+\n${big}${big}Node 99`,
		".nvmrc": big,
		".node-version": big,
		".python-version": big,
		".go-version": big,
		"mise.toml": big,
		".mise.toml": big,
		"mise/config.toml": big,
		".mise/config.toml": big,
		".config/mise.toml": big,
	});
	t.after(() =>
		Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]),
	);
	await symlink(join(outside, "go.mod"), join(root, "go.mod"));
	await mkdir(join(root, "package.json"));
	await symlink(outside, join(root, ".github"));
	const read = readDiscoveryFiles(root);
	const reasons = Object.fromEntries(read.skipped.map((entry) => [entry.path, entry.reason]));
	assert.equal(reasons["go.mod"], "not_regular");
	assert.equal(reasons["package.json"], "not_regular");
	assert.equal(reasons.Makefile, "too_large");
	assert.ok(Object.values(reasons).includes("limit"));
	assert.equal(read.truncated, true);
	assert.ok(
		read.files.reduce((total, file) => total + Buffer.byteLength(file.text), 0) <= DISCOVERY_LIMITS.totalBytes,
	);
	assert.ok(!read.files.some((file) => file.path.startsWith(".github/")), "linked directories are not followed");
	const readme = read.files.find((file) => file.path === "README.md");
	if (readme) assert.ok(Buffer.byteLength(readme.text) <= DISCOVERY_LIMITS.docBytes);
	assert.doesNotMatch(JSON.stringify(resolveDiscovery("p1", read)), /1\.30\.0|Node 99/);
});

test("workflow files are hints only and capped", async (t) => {
	const files: Record<string, string> = {
		".tool-versions": "golang 1.23.4\n",
		".github/workflows/ci.yml": [
			"jobs:",
			"  lint:",
			"    services:",
			"      db:",
			"        image: postgres:15",
			"    steps:",
			"      - uses: actions/setup-go@v5",
			"        with:",
			"          go-version: '1.21'",
			"      - uses: golangci/golangci-lint-action@v6",
			"        with:",
			"          version: v1.61.0",
		].join("\n"),
	};
	for (let index = 0; index < DISCOVERY_LIMITS.workflows + 2; index++)
		files[`.github/workflows/extra-${String(index).padStart(2, "0")}.yaml`] = "on: push\n";
	const root = await checkout(files);
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = discover(root);
	assert.equal(result.truncated, true);
	assert.equal(
		result.sources.filter((source) => source.path.startsWith(".github/")).length,
		DISCOVERY_LIMITS.workflows,
	);
	const go = result.subjects.find((entry) => entry.subject === "go")!;
	assert.equal(go.status, "proposed", "a CI pin never creates a conflict");
	assert.deepEqual(go.notes, ["CI mentions 1.21"]);
	assert.equal(result.subjects.find((entry) => entry.subject === "golangci-lint")!.status, "hint_only");
	assert.equal(result.subjects.find((entry) => entry.subject === "postgres")!.status, "hint_only");
});

test("parsers: mise tables, version files, package.json and go tool directives", () => {
	const mise = parse(
		"mise.toml",
		[
			"[tools]",
			'go = "1.23"',
			'node = ["20.11.1", "18"]',
			'"aqua:golangci/golangci-lint" = { version = "v1.61.0", os = ["linux"] }',
			'python = "latest" # newest',
			"[tools.pnpm]",
			'version = "9.12.0"',
			"[env]",
			'DATABASE_URL = "postgres://x"',
		].join("\n"),
	).findings;
	assert.deepEqual(
		mise.map((finding) => [finding.subject, finding.kind, finding.value ?? null, finding.source.line]),
		[
			["go", "range", "1.23", 2],
			["node", "exact", "20.11.1", 3],
			["golangci-lint", "exact", "1.61.0", 4],
			["python", "unknown", null, 5],
			["pnpm", "exact", "9.12.0", 7],
		],
	);
	assert.equal(mise[3]!.note, "alias latest");

	const nvmrc = parse(".nvmrc", "# comment\nlts/*\n").findings;
	assert.deepEqual([nvmrc[0]!.kind, nvmrc[0]!.note, nvmrc[0]!.source.line], ["unknown", "alias lts/*", 2]);

	const pkg = parse(
		"package.json",
		'{\n  "name": "web",\n  "packageManager": "pnpm@9.12.0+sha512.abc",\n  "engines": {\n    "node": ">=20"\n  }\n}\n',
	).findings;
	assert.deepEqual(
		pkg.map((finding) => [finding.subject, finding.kind, finding.value, finding.source.line, finding.note]),
		[
			["pnpm", "exact", "9.12.0", 3, "integrity hash pinned"],
			["node", "minimum", "20", 5, "engines"],
		],
	);

	const goMod = parse(
		"go.mod",
		[
			"module x",
			"go 1.24",
			"require (",
			"\tgithub.com/golangci/golangci-lint v1.61.0 // indirect",
			"\tgolang.org/x/tools v0.30.0",
			")",
			"tool (",
			"\tgithub.com/golangci/golangci-lint/cmd/golangci-lint",
			"\tgolang.org/x/tools/cmd/stringer",
			"\texample.com/unknown/v2/cmd/thing",
			")",
		].join("\n"),
	).findings;
	assert.deepEqual(
		goMod.map((finding) => [finding.subject, finding.kind, finding.value ?? null, finding.source.line]),
		[
			["go", "minimum", "1.24", 2],
			["golangci-lint", "exact", "1.61.0", 8],
			["stringer", "exact", "0.30.0", 9],
			["thing", "unknown", null, 10],
		],
	);
	const resolved = resolveDiscovery("p", {
		files: [
			{ path: "go.mod", text: "go 1.24\nrequire github.com/a/lint v1.2.3\ntool github.com/a/lint\n", sha256: "0" },
		],
		skipped: [],
		truncated: false,
	});
	assert.equal(resolved.subjects.find((entry) => entry.subject === "lint")!.goTool, true);

	const just = parse(
		"justfile",
		'golangci_lint_version := "v1.60.3"\nset shell := ["bash"]\nbootstrap:\n  ./x\ntest *args:\n  go test\n',
	);
	assert.deepEqual(
		just.findings.map((finding) => [finding.subject, finding.value]),
		[["golangci-lint", "1.60.3"]],
	);
	assert.deepEqual(
		just.steps.map((step) => step.run.argv),
		[
			["just", "bootstrap"],
			["just", "test"],
		],
	);
});

test("resolution: constraint violations conflict, constraints alone need a version, hints never choose", () => {
	const resolve = (files: Record<string, string>) =>
		resolveDiscovery("p", {
			files: Object.entries(files).map(([path, text]) => ({ path, text, sha256: "0" })),
			skipped: [],
			truncated: false,
		}).subjects;
	const violated = resolve({ "go.mod": "go 1.22.0\n", ".tool-versions": "golang 1.21.9\n" });
	assert.equal(violated[0]!.status, "conflict");
	const onlyMinimum = resolve({ "go.mod": "go 1.22\n" });
	assert.equal(onlyMinimum[0]!.status, "needs_version");
	assert.equal(onlyMinimum[0]!.value, undefined);
	const engines = resolve({ "package.json": '{"engines":{"node":"^18 || ^20"}}', ".nvmrc": "20.11.1\n" });
	assert.equal(engines.find((entry) => entry.subject === "node")!.status, "proposed");
	const unreadable = resolve({ "package.json": '{"engines":{"node":"lts-ish"}}', ".nvmrc": "20.11.1\n" });
	assert.deepEqual(unreadable.find((entry) => entry.subject === "node")!.notes, [
		"Couldn't check package.json:1 (engines; alias lts-ish)",
	]);
	const readmeOnly = resolve({ "README.md": "Needs Go 1.21+" });
	assert.equal(readmeOnly[0]!.status, "hint_only");
	const majors = resolve({
		"compose.yaml": "services:\n  a:\n    image: postgres:16\n  b:\n    image: bitnami/postgresql:15.4.0\n",
	});
	assert.equal(majors[0]!.status, "conflict");
	const disagreeingHint = resolve({ ".tool-versions": "golang 1.23.4\n", "README.md": "Go 1.21 only" });
	assert.deepEqual(disagreeingHint[0]!.notes, ["README.md mentions 1.21"]);
});

test("version constraints", () => {
	assert.equal(satisfies("1.23.4", { kind: "minimum", value: "1.22.0" }), true);
	assert.equal(satisfies("1.21.9", { kind: "minimum", value: "1.22" }), false);
	assert.equal(satisfies("16.4.0", { kind: "major", value: "16" }), true);
	assert.equal(satisfiesRange("1.23.4", "1.23"), true);
	assert.equal(satisfiesRange("1.230.0", "1.23"), false);
	assert.equal(satisfiesRange("20.11.1", ">=18 <21"), true);
	assert.equal(satisfiesRange("21.0.0", ">=18 <21"), false);
	assert.equal(satisfiesRange("20.1.0", "^18 || ^20"), true);
	assert.equal(satisfiesRange("20.1.0", "~20.2"), false);
	assert.equal(satisfiesRange("1.2.3", "1.x"), true);
	assert.equal(satisfiesRange("1.2.3", "workspace:*"), undefined);
});

test("the read list includes every copied local mise config", () => {
	assert.deepEqual(MISE_LOCAL_FILES, localConfigs);
	for (const path of localConfigs) assert.ok(DISCOVERY_FILES.includes(path), path);
});
