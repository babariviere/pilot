import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProjectEnvironment } from "@pilot/protocol";
import {
	applyEnvironmentApprovals,
	EnvironmentApprovalRequired,
	effectiveEnvironment,
	isSafeRelativePath,
	validateEnvironmentOverride,
	validateEnvironmentProfile,
	validateProjectEnvironment,
	validateProjectEnvironmentOverride,
} from "./environment-profile.ts";
import { daemonHello, environmentSetupEnabled } from "./hello.ts";
import { EnvironmentRevisionConflict, ProjectStore } from "./projects.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

/** The Go service worked example from docs/environment-setup.md. */
export function goServiceProfile(): Omit<ProjectEnvironment, "revision"> {
	return {
		tools: [
			{ id: "go", version: "1.23.4", from: { path: "go.mod", line: 5 } },
			{ id: "golangci-lint", version: "1.61.0", from: "user" },
		],
		services: [
			{
				id: "postgres",
				kind: "postgres",
				version: "16",
				provider: "pilot",
				database: "orders",
				dbTool: { read: "allow", write: "allow" },
				exports: { DATABASE_URL: "url" },
			},
		],
		steps: [
			{
				id: "setup",
				title: "Download modules and migrate",
				run: { argv: ["make", "setup"] },
				review: {
					files: [
						{ path: "Makefile", sha256: A },
						{ path: "scripts/bootstrap.sh", sha256: B },
					],
					reviewedAt: 1792345678000,
				},
				inputs: ["go.sum", "migrations"],
				requires: ["go", "postgres"],
			},
		],
		confirmedSources: [
			{ path: "go.mod", sha256: A },
			{ path: ".tool-versions", sha256: B },
		],
	};
}

test("the worked example validates unchanged", () => {
	const profile = goServiceProfile();
	assert.deepEqual(validateEnvironmentProfile(profile), profile);
	assert.deepEqual(validateProjectEnvironment({ ...profile, revision: 3 }), { revision: 3, ...profile });
});

test("versions are exact and normalized, never ranges, aliases or latest", () => {
	const withVersion = (version: string) =>
		validateEnvironmentProfile({ ...goServiceProfile(), tools: [{ id: "go", version, from: "user" }], steps: [] });
	assert.equal(withVersion("go1.23.4").tools[0]!.version, "1.23.4");
	assert.equal(withVersion("v1.61.0").tools[0]!.version, "1.61.0");
	for (const bad of ["latest", "lts", ">=1.22", "1.22 || 1.23", "^1.2", "", "lts/*"])
		assert.throws(() => withVersion(bad), /version/);
});

test("profiles reject unknown fields, unsafe paths, shell strings and dangling requirements", () => {
	const cases: [string, (profile: Record<string, unknown> & ReturnType<typeof goServiceProfile>) => void, RegExp][] = [
		["unknown top-level field", (p) => Object.assign(p, { installers: [] }), /unknown field: installers/],
		[
			"traversal in a source",
			(p) => p.confirmedSources.push({ path: "../etc/passwd", sha256: A }),
			/checkout-relative/,
		],
		["absolute input", (p) => (p.steps[0]!.inputs = ["/etc/hosts"]), /checkout-relative/],
		["bad hash", (p) => (p.confirmedSources[0]!.sha256 = "abc"), /sha256/],
		[
			"shell string run",
			(p) => ((p.steps[0] as { run: unknown }).run = "make setup && curl x | sh"),
			/must be an object/,
		],
		["empty argv", (p) => (p.steps[0]!.run = { argv: [] }), /must not be empty/],
		["unknown requirement", (p) => (p.steps[0]!.requires = ["redis"]), /unknown tool or service/],
		["duplicate tool", (p) => p.tools.push({ id: "go", version: "1.22.0", from: "user" }), /twice/],
		["timeout too long", (p) => (p.steps[0]!.timeoutMs = 2 * 60 * 60_000), /60 minutes/],
		[
			"compose on built-in",
			(p) => (p.services[0]!.compose = { file: "compose.yaml", service: "db" }),
			/compose provider/,
		],
		[
			"compose without file",
			(p) => (p.services[0] = { ...p.services[0]!, provider: "compose", database: undefined, dbTool: undefined }),
			/database applies|compose must be/,
		],
		["bad export", (p) => (p.services[0]!.exports = { DATABASE_URL: "password" as never }), /unknown value/],
		["reserved export", (p) => (p.services[0]!.exports = { PATH: "url" }), /not allowed/],
		["version command", (p) => Object.assign(p.tools[0]!, { versionCommand: ["go", "version"] }), /unknown field/],
		["multi-line title", (p) => (p.steps[0]!.title = "a\nb"), /one line/],
	];
	for (const [name, mutate, error] of cases) {
		const profile = structuredClone(goServiceProfile()) as ReturnType<typeof goServiceProfile> &
			Record<string, unknown>;
		mutate(profile);
		assert.throws(() => validateEnvironmentProfile(JSON.parse(JSON.stringify(profile))), error, name);
	}
});

test("env keeps plain variables and rejects secrets and reserved names", () => {
	const withEnv = (env: Record<string, string>) => validateEnvironmentProfile({ ...goServiceProfile(), env });
	assert.deepEqual(withEnv({ GOFLAGS: "-mod=mod", APP_ENV: "test" }).env, { GOFLAGS: "-mod=mod", APP_ENV: "test" });
	const secrets: Record<string, string>[] = [
		{ API_KEY: "x" },
		{ GITHUB_TOKEN: "x" },
		{ DB_PASSWORD: "x" },
		{ SENTRY_DSN: "x" },
		{ UPSTREAM: "https://user:****@example.com" },
		{ HEADER: "Bearer abc" },
		{ X: "ghp_abcdefghijklmnop" },
		{ PATH: "/tmp" },
		{ PILOT_HOME: "/tmp" },
		{ DYLD_INSERT_LIBRARIES: "/tmp/x" },
		{ DATABASE_URL: "postgres://localhost/x" },
	];
	for (const env of secrets)
		assert.throws(() => withEnv(env), /secret|not allowed|already exported/, JSON.stringify(env));
});

test("safe relative paths", () => {
	for (const ok of ["go.mod", ".tool-versions", "scripts/bootstrap.sh", ".github/workflows/ci.yml"])
		assert.ok(isSafeRelativePath(ok), ok);
	for (const bad of ["", "/abs", "../x", "a/../b", "a//b", "./a", "a\\b", "a\u0000b", "x".repeat(513)])
		assert.equal(isSafeRelativePath(bad), false, bad);
});

test("approvals: kept unchanged, cleared on run changes, and new ones need native approval", () => {
	const previous: ProjectEnvironment = { revision: 1, ...goServiceProfile() };
	assert.deepEqual(applyEnvironmentApprovals(previous, goServiceProfile(), false), goServiceProfile(), "unchanged");

	const changedRun = goServiceProfile();
	changedRun.steps[0]!.run = { argv: ["make", "bootstrap"] };
	assert.equal(applyEnvironmentApprovals(previous, changedRun, false).steps[0]!.review, undefined);
	assert.equal(applyEnvironmentApprovals(previous, changedRun, true).steps[0]!.review, undefined, "stale pin");

	const removed = goServiceProfile();
	delete removed.steps[0]!.review;
	assert.equal(applyEnvironmentApprovals(previous, removed, false).steps[0]!.review, undefined, "removal is safe");

	const forged = goServiceProfile();
	forged.steps[0]!.review = { files: [{ path: "Makefile", sha256: B }], reviewedAt: 2 };
	assert.throws(() => applyEnvironmentApprovals(previous, forged, false), EnvironmentApprovalRequired);
	assert.throws(() => applyEnvironmentApprovals(undefined, goServiceProfile(), false), EnvironmentApprovalRequired);
	assert.deepEqual(applyEnvironmentApprovals(previous, forged, true).steps[0]!.review, forged.steps[0]!.review);

	const compose = (file: string, review?: boolean) => {
		const profile = goServiceProfile();
		profile.services = [
			{
				id: "postgres",
				kind: "postgres",
				version: "16",
				provider: "compose",
				exports: {},
				compose: {
					file,
					service: "db",
					...(review ? { review: { files: [{ path: file, sha256: A }], reviewedAt: 1 } } : {}),
				},
			},
		];
		return profile;
	};
	const composed: ProjectEnvironment = { revision: 2, ...compose("compose.yaml", true) };
	assert.ok(applyEnvironmentApprovals(composed, compose("compose.yaml", true), false).services[0]!.compose!.review);
	const moved = compose("compose.yaml", true);
	moved.services[0]!.compose!.file = "docker-compose.yml";
	assert.equal(applyEnvironmentApprovals(composed, moved, false).services[0]!.compose!.review, undefined);
	assert.throws(
		() =>
			applyEnvironmentApprovals({ revision: 1, ...compose("compose.yaml") }, compose("compose.yaml", true), false),
		EnvironmentApprovalRequired,
	);
});

test("ProjectStore saves profiles with revision checks and approval rules", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-store-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new ProjectStore(home);
	await store.load();
	const project = await store.create({ path: home });
	const withoutReview = goServiceProfile();
	delete withoutReview.steps[0]!.review;

	await assert.rejects(
		store.updateEnvironment(project.id, goServiceProfile(), 0, { native: false }),
		EnvironmentApprovalRequired,
	);
	assert.equal(store.require(project.id).environment, undefined, "no mutation before validation");
	await assert.rejects(store.updateEnvironment(project.id, { tools: [] }, 0, { native: false }), /must be a list/);
	await assert.rejects(store.updateEnvironment(project.id, withoutReview, -1, { native: false }), /expectedRevision/);
	await assert.rejects(store.updateEnvironment("missing", withoutReview, 0, { native: false }), /Unknown project/);

	const first = await store.updateEnvironment(project.id, withoutReview, 0, { native: false });
	assert.equal(first.revision, 1);
	const stale = await store.updateEnvironment(project.id, withoutReview, 0, { native: false }).catch((error) => error);
	assert.ok(stale instanceof EnvironmentRevisionConflict);
	assert.equal(stale.revision, 1);

	const approved = await store.updateEnvironment(project.id, { ...goServiceProfile(), revision: 99 }, 1, {
		native: true,
	});
	assert.equal(approved.revision, 2, "the daemon assigns revisions");
	assert.ok(approved.steps[0]!.review);
	await store.update(project.id, { name: "Orders" });
	assert.deepEqual(store.require(project.id).environment, approved, "project updates keep the profile");

	const reloaded = new ProjectStore(home);
	await reloaded.load();
	assert.deepEqual(reloaded.require(project.id).environment, approved);
});

test("an invalid stored profile is hidden from clients but kept on disk", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-invalid-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const broken = { revision: 4, tools: "go", services: [], steps: [], confirmedSources: [] };
	await writeFile(
		join(home, "projects.json"),
		JSON.stringify([{ id: "p1", name: "p", path: home, createdAt: 1, environment: broken }]),
	);
	const store = new ProjectStore(home);
	await store.load();
	assert.equal(store.require("p1").environment, undefined);
	await store.update("p1", { name: "renamed" });
	const saved = JSON.parse(await readFile(join(home, "projects.json"), "utf8"));
	assert.deepEqual(saved[0].environment, broken, "a later save never drops a hand edit");
	await assert.rejects(
		store.updateEnvironment("p1", { tools: [], services: [], steps: [], confirmedSources: [] }, 0, { native: false }),
		EnvironmentRevisionConflict,
	);
	const replaced = await store.updateEnvironment(
		"p1",
		{ tools: [], services: [], steps: [], confirmedSources: [] },
		4,
		{ native: false },
	);
	assert.equal(replaced.revision, 5);
});

test("the capability flag stays off unless explicitly enabled", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-hello-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const capabilities = {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: false,
		independentExecution: true,
	};
	assert.equal(environmentSetupEnabled({}), false);
	assert.equal(environmentSetupEnabled({ PILOT_ENVIRONMENT_SETUP: "true" }), false);
	assert.equal((await daemonHello(home, capabilities, {})).capabilities.environmentSetup, undefined);
	assert.equal(
		(await daemonHello(home, capabilities, { PILOT_ENVIRONMENT_SETUP: "1" })).capabilities.environmentSetup,
		1,
	);
});

test("copyFiles lists ignored local files by path only", () => {
	const withFiles = (copyFiles: unknown) => validateEnvironmentProfile({ ...goServiceProfile(), copyFiles });
	assert.deepEqual(withFiles([".env", ".env.local", "config/dev.env"]).copyFiles, [
		".env",
		".env.local",
		"config/dev.env",
	]);
	for (const bad of [
		["../.env"],
		["/etc/passwd"],
		[".git/config"],
		["a/.jj/x"],
		[".env", ".env"],
		Array.from({ length: 33 }, (_, i) => `f${i}`),
	])
		assert.throws(() => withFiles(bad), /copyFiles|list/, JSON.stringify(bad));
	const longName = {
		...goServiceProfile(),
		services: [{ ...goServiceProfile().services[0]!, database: "x".repeat(33) }],
	};
	assert.throws(() => validateEnvironmentProfile(longName), /database/);
});

test("a host override replaces, removes and adds entries, merges env and adds local files", () => {
	const shared: ProjectEnvironment = {
		revision: 4,
		...goServiceProfile(),
		env: { GOFLAGS: "-mod=mod", APP_ENV: "dev" },
		copyFiles: [".env"],
	};
	const override = validateProjectEnvironmentOverride({
		revision: 2,
		tools: [
			{ id: "go", version: "1.23.2", from: "user" },
			{ id: "terraform", version: "1.9.5", from: "user" },
		],
		remove: ["golangci-lint"],
		env: { GOFLAGS: "-p=2" },
		copyFiles: [".env.local", ".env"],
	});
	const effective = effectiveEnvironment(shared, override)!;
	assert.equal(effective.revision, 4, "the shared revision is kept; plans record the override revision");
	assert.deepEqual(
		effective.tools.map((tool) => [tool.id, tool.version]),
		[
			["go", "1.23.2"],
			["terraform", "1.9.5"],
		],
	);
	assert.deepEqual(effective.env, { GOFLAGS: "-p=2", APP_ENV: "dev" });
	assert.deepEqual(effective.copyFiles, [".env", ".env.local"]);
	assert.deepEqual(effective.steps, shared.steps);
	assert.equal(effectiveEnvironment(shared, undefined), shared);

	const removedService = effectiveEnvironment(shared, { revision: 1, remove: ["postgres"] })!;
	assert.deepEqual(removedService.steps[0]!.requires, ["go"], "steps keep only requirements that still exist");
	assert.deepEqual(effectiveEnvironment(undefined, { revision: 1, env: { A: "b" } }), {
		revision: 0,
		tools: [],
		services: [],
		steps: [],
		confirmedSources: [],
		env: { A: "b" },
	});
	assert.throws(() => validateEnvironmentOverride({ tools: [], extra: 1 }), /unknown field: extra/);
	assert.throws(() => validateEnvironmentOverride({ env: { API_TOKEN: "x" } }), /secret/);
});

test("ProjectStore keeps a host override with its own revision and the same approval rules", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-override-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new ProjectStore(home);
	await store.load();
	const project = await store.create({ path: home });
	const shared = goServiceProfile();
	delete shared.steps[0]!.review;
	await store.updateEnvironment(project.id, shared, 0, { native: false });

	const first = await store.updateEnvironmentOverride(project.id, { env: { GOFLAGS: "-p=2" } }, 0, { native: false });
	assert.equal(first.revision, 1);
	assert.equal(store.require(project.id).environment?.revision, 1, "the shared revision is independent");
	await assert.rejects(
		store.updateEnvironmentOverride(project.id, {}, 0, { native: false }),
		EnvironmentRevisionConflict,
	);
	const review = { files: [{ path: "Makefile", sha256: A }], reviewedAt: 3 };
	const hostStep = {
		id: "seed",
		title: "Seed",
		run: { argv: ["make", "seed"] },
		review,
		inputs: [],
		requires: ["postgres"],
	};
	await assert.rejects(
		store.updateEnvironmentOverride(project.id, { steps: [hostStep] }, 1, { native: false }),
		EnvironmentApprovalRequired,
	);
	await assert.rejects(
		store.updateEnvironmentOverride(
			project.id,
			{ steps: [{ ...hostStep, review: undefined, requires: ["redis"] }] },
			1,
			{ native: false },
		),
		/unknown tool or service/,
		"requirements are checked on the effective profile",
	);
	const second = await store.updateEnvironmentOverride(project.id, { steps: [hostStep] }, 1, { native: true });
	assert.deepEqual(second.steps?.[0]?.review, review);
	const cleared = await store.updateEnvironmentOverride(project.id, {}, 2, { native: false });
	assert.deepEqual(cleared, { revision: 3 });

	const reloaded = new ProjectStore(home);
	await reloaded.load();
	assert.deepEqual(reloaded.require(project.id).environmentOverride, { revision: 3 });
});
