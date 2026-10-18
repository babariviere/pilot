import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnvironmentPlanItem, ProjectEnvironment } from "@pilot/protocol";
import { computeEnvironmentPlan, type PlanInput } from "./environment-plan.ts";
import type { EnvironmentProbes } from "./environment-probes.ts";

const pin = { files: [{ path: "Makefile", sha256: "a".repeat(64) }], reviewedAt: 1 };

/** The Go service worked example profile from docs/environment-setup.md. */
const profile: ProjectEnvironment = {
	revision: 1,
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
			exports: { DATABASE_URL: "url" },
		},
	],
	steps: [
		{
			id: "setup",
			title: "Download modules and migrate",
			run: { argv: ["make", "setup"] },
			review: pin,
			inputs: ["go.sum"],
			requires: ["go", "postgres"],
		},
	],
	confirmedSources: [],
};

const GO = "/Users/me/.local/share/mise/installs/go/1.23.4";

function plan(probes: Partial<EnvironmentProbes>, overrides: Partial<PlanInput> = {}) {
	return computeEnvironmentPlan({
		projectId: "p1",
		host: { daemonId: "d1", platform: "darwin", arch: "arm64" },
		profile,
		probes: { postgres: {}, installers: {}, exhausted: false, ...probes },
		goTools: {},
		reviews: { setup: [] },
		now: 7,
		...overrides,
	});
}

function summary(items: EnvironmentPlanItem[]) {
	return items.map((item) => [item.subject, item.action, item.installer ?? null, item.approval, item.commands]);
}

test("worked example on Local macOS: what mise has needs nothing, the rest installs with mise", () => {
	const result = plan({
		mise: {
			go: [{ version: "1.23.4", path: GO }],
			"golangci-lint": [{ version: "1.60.3", path: "/m/golangci-lint/1.60.3" }],
		},
		postgres: { "16": [{ path: "/opt/homebrew/opt/postgresql@16/bin/postgres", version: "16.4" }] },
		installers: { mise: "/Users/me/.local/bin/mise", homebrew: "/opt/homebrew/bin/brew" },
	});
	assert.deepEqual(summary(result.items), [
		["go", "none", "mise", "plan", []],
		["golangci-lint", "install", "mise", "plan", [["/Users/me/.local/bin/mise", "install", "golangci-lint@1.61.0"]]],
		["postgres", "start", "pilot", "plan", []],
		["step:setup", "run", null, "plan", [["make", "setup"]]],
	]);
	assert.deepEqual(result.items[0]!.present, { version: "1.23.4", path: GO });
	assert.deepEqual(result.items[1]!.impact, { network: [] }, "no guessed download hosts");
	assert.equal(result.items[1]!.note, "mise has 1.60.3; it stays installed.");
	assert.equal(result.profileRevision, 1);
	assert.equal(result.computedAt, 7);
	assert.match(result.planHash, /^[0-9a-f]{64}$/);
});

test("any tool in mise's registry is installable; unknown names are not", () => {
	const custom = {
		...profile,
		tools: [
			{ id: "terraform", version: "1.9.5", from: "user" as const },
			{ id: "aqua:owner/tool", version: "1.0.0", from: "user" as const },
			{ id: "notatool", version: "1.0.0", from: "user" as const },
		],
		services: [],
		steps: [],
	};
	const result = plan({ installers: { mise: "/m" } }, { profile: custom, registry: ["go", "terraform"] });
	assert.deepEqual(summary(result.items), [
		["terraform", "install", "mise", "plan", [["/m", "install", "terraform@1.9.5"]]],
		["aqua:owner/tool", "install", "mise", "plan", [["/m", "install", "aqua:owner/tool@1.0.0"]]],
		["notatool", "manual", null, "user-runs", []],
	]);
	assert.match(result.items[2]!.note!, /mise doesn't know notatool/);
	assert.equal(
		plan({ installers: { mise: "/m" } }, { profile: custom }).items[2]!.action,
		"install",
		"an unread registry never blocks",
	);
});

test("Postgres without Homebrew or system binaries uses Pilot's Docker container, else explains what to install", () => {
	const linux = { host: { daemonId: "d2", platform: "linux", arch: "x64" } };
	const docker = plan({ installers: { mise: "/m", docker: "/usr/bin/docker", system: "apt-get" } }, linux);
	const postgres = docker.items.find((item) => item.subject === "postgres")!;
	assert.deepEqual([postgres.action, postgres.installer, postgres.approval], ["start", "docker", "plan"]);
	assert.match(postgres.note!, /container \(postgres:16, data in a named volume, reachable on loopback only\)/);

	const apt = plan({ installers: { mise: "/m", system: "apt-get" } }, linux).items.find(
		(item) => item.subject === "postgres",
	)!;
	assert.deepEqual(
		[apt.action, apt.approval, apt.commands],
		["manual", "user-runs", [["sudo", "apt-get", "install", "-y", "postgresql-16"]]],
	);
	assert.match(apt.note!, /Install Homebrew or Docker/);
	const dnf = plan({ installers: { system: "dnf" } }).items.find((item) => item.subject === "postgres")!;
	assert.deepEqual(dnf.commands, [["sudo", "dnf", "install", "-y", "postgresql16-server"]]);
	const bare = plan({}).items.find((item) => item.subject === "postgres")!;
	assert.deepEqual([bare.commands, bare.note], [[], "Install Homebrew or Docker on this host, then check again."]);
	assert.ok(
		[docker, plan({ installers: { system: "apt-get" } })].every((result) =>
			result.items
				.filter((item) => item.approval === "plan")
				.every((item) => !item.commands.flat().includes("sudo")),
		),
		"Pilot never runs sudo",
	);
	const brew = plan({ installers: { homebrew: "/opt/homebrew/bin/brew", docker: "/d" } }).items.find(
		(item) => item.subject === "postgres",
	)!;
	assert.deepEqual(brew.commands, [["/opt/homebrew/bin/brew", "install", "postgresql@16"]], "Homebrew comes first");
});

test("without mise, Homebrew installs mise first; without either, the user installs one", () => {
	const brew = plan({ installers: { homebrew: "/home/linuxbrew/.linuxbrew/bin/brew" } });
	assert.deepEqual(summary(brew.items).slice(0, 3), [
		["mise", "install", "homebrew", "plan", [["/home/linuxbrew/.linuxbrew/bin/brew", "install", "mise"]]],
		["go", "install", "mise", "plan", [["/home/linuxbrew/.linuxbrew/bin/mise", "install", "go@1.23.4"]]],
		[
			"golangci-lint",
			"install",
			"mise",
			"plan",
			[["/home/linuxbrew/.linuxbrew/bin/mise", "install", "golangci-lint@1.61.0"]],
		],
	]);
	const bare = plan({});
	assert.deepEqual(
		bare.items.map((item) => [item.subject, item.action, item.approval]),
		[
			["go", "manual", "user-runs"],
			["golangci-lint", "manual", "user-runs"],
			["postgres", "manual", "user-runs"],
			["step:setup", "run", "plan"],
		],
	);
	assert.match(bare.items[0]!.note!, /Install mise \(mise\.jdx\.dev\) or Homebrew/);
	const installed = plan({
		installers: { homebrew: "/opt/homebrew/bin/brew" },
		mise: { go: [{ version: "1.23.4", path: GO }], "golangci-lint": [{ version: "1.61.0", path: "/l" }] },
	});
	assert.ok(
		!installed.items.some((item) => item.subject === "mise"),
		"mise is only installed when something needs it",
	);
});

test("go tool directives, step reviews and compose services", () => {
	const goTool = plan({ installers: { mise: "/m" } }, { goTools: { "golangci-lint": "1.61.0" } });
	const lint = goTool.items.find((item) => item.subject === "golangci-lint")!;
	assert.deepEqual([lint.action, lint.installer], ["none", "go-tool"]);
	assert.equal(
		plan({ installers: { mise: "/m" } }, { goTools: { "golangci-lint": "1.60.3" } }).items[1]!.action,
		"install",
		"a different go.mod version still needs the confirmed one",
	);
	const changed = plan({}, { reviews: { setup: ["Makefile"] } }).items.at(-1)!;
	assert.deepEqual(
		[changed.action, changed.note],
		["review", "Makefile changed since review. Review it to run setup."],
	);
	const unreviewed = plan(
		{},
		{ profile: { ...profile, steps: [{ ...profile.steps[0]!, review: undefined }] } },
	).items.at(-1)!;
	assert.equal(unreviewed.action, "review");

	const compose = {
		...profile,
		steps: [],
		services: [
			{
				id: "db",
				kind: "postgres" as const,
				version: "16",
				provider: "compose" as const,
				exports: {},
				compose: { file: "compose.yaml", service: "db" },
			},
		],
	};
	assert.equal(plan({}, { profile: compose }).items.at(-1)!.action, "review");
	const reviewed = {
		...compose,
		services: [{ ...compose.services[0]!, compose: { ...compose.services[0]!.compose, review: pin } }],
	};
	assert.equal(
		plan({}, { profile: reviewed, reviews: { "service:db": [] } }).items.at(-1)!.action,
		"manual",
		"Docker missing",
	);
	assert.deepEqual(
		plan(
			{ installers: { docker: "/usr/bin/docker" } },
			{ profile: reviewed, reviews: { "service:db": [] } },
		).items.at(-1)!.commands,
		[["/usr/bin/docker", "compose", "-p", "pilot-p1", "-f", "compose.yaml", "up", "-d", "db"]],
	);
});

test("plan hashes cover the profile revision and what probes found, not the time", () => {
	const probes = { installers: { mise: "/m" } };
	assert.equal(plan(probes).planHash, plan(probes, { now: 99 }).planHash);
	assert.notEqual(plan(probes).planHash, plan(probes, { profile: { ...profile, revision: 2 } }).planHash);
	assert.notEqual(
		plan(probes).planHash,
		plan({ ...probes, mise: { go: [{ version: "1.23.4", path: GO }] } }).planHash,
	);
	assert.notEqual(
		plan(probes).planHash,
		plan(probes, { host: { daemonId: "other", platform: "darwin", arch: "arm64" } }).planHash,
	);
	const empty = plan(probes, { profile: undefined });
	assert.deepEqual([empty.profileRevision, empty.overrideRevision, empty.items], [0, 0, []]);
	const overridden = plan(probes, { overrideRevision: 3 });
	assert.equal(overridden.overrideRevision, 3);
	assert.notEqual(overridden.planHash, plan(probes).planHash, "the host's override revision is covered");
});
