import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { DependencySources, escapeGoPath, parseCargoLock, parseGoMod } from "./reference-sources.ts";

const GO_MOD = `module example.com/service

go 1.27.0

tool github.com/sqlc-dev/sqlc/cmd/sqlc

require github.com/Azure/azure-sdk-for-go/sdk/azcore v1.24.0

require (
	github.com/stoikio/eventbus-schema/go v0.32.0
	"github.com/BurntSushi/toml" v1.4.0 // indirect
	github.com/old/name v1.0.0
	github.com/pinned/only v1.0.0
	github.com/local/fork v0.1.0
	../../escape v1.0.0
)

replace github.com/old/name => github.com/New/name v2.0.0
replace (
	github.com/pinned/only v0.9.0 => github.com/never/used v9.0.0
	github.com/local/fork => ../fork
)
`;

test("go.mod requirements apply replace rules and Go's case escaping", () => {
	assert.equal(escapeGoPath("github.com/Azure/AzureSDK"), "github.com/!azure/!azure!s!d!k");
	assert.deepEqual(parseGoMod(GO_MOD), [
		{ path: "github.com/Azure/azure-sdk-for-go/sdk/azcore", version: "v1.24.0", indirect: false },
		{ path: "github.com/stoikio/eventbus-schema/go", version: "v0.32.0", indirect: false },
		{ path: "github.com/BurntSushi/toml", version: "v1.4.0", indirect: true },
		{ path: "github.com/New/name", version: "v2.0.0", indirect: false },
		// A versioned replace that does not match the required version leaves it unchanged.
		{ path: "github.com/pinned/only", version: "v1.0.0", indirect: false },
		// A local directory replacement and an unsafe module path are not cache entries.
	]);
});

test("Cargo.lock gives the registry crates that workspace members use directly", () => {
	const lock = `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
 "syn 2.0.1",
 "local-lib",
]

[[package]]
name = "local-lib"
version = "0.1.0"
dependencies = ["itoa"]

[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = ["serde_derive"]

[[package]]
name = "serde_derive"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "syn"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "syn"
version = "2.0.1"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "itoa"
version = "1.0.11"
source = "sparse+https://index.crates.io/"
`;
	assert.deepEqual(parseCargoLock(lock), [
		{ name: "serde", version: "1.0.200" },
		{ name: "syn", version: "2.0.1" },
		{ name: "itoa", version: "1.0.11" },
	]);
});

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-dependency-sources-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const goModCache = join(root, "gomod");
	const cargoHome = join(root, "cargo");
	await mkdir(project);
	return { root, project, goModCache, cargoHome, sources: new DependencySources({ goModCache, cargoHome }) };
}

test("dependency sources resolve existing cache directories and rerun only after a lock change", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.project, "go.mod"), GO_MOD);
	const schema = join(f.goModCache, "github.com", "stoikio", "eventbus-schema", "go@v0.32.0");
	const azure = join(f.goModCache, "github.com", "!azure", "azure-sdk-for-go", "sdk", "azcore@v1.24.0");
	const toml = join(f.goModCache, "github.com", "!burnt!sushi", "toml@v1.4.0");
	const renamed = join(f.goModCache, "github.com", "!new", "name@v2.0.0");
	for (const dir of [schema, azure, toml, renamed]) await mkdir(dir, { recursive: true });
	// Missing from the cache: github.com/pinned/only. A symlink out of the cache is not a source.
	await mkdir(join(f.root, "elsewhere"));
	await mkdir(join(f.goModCache, "github.com", "pinned"), { recursive: true });
	await symlink(join(f.root, "elsewhere"), join(f.goModCache, "github.com", "pinned", "only@v1.0.0"));
	await writeFile(
		join(f.project, "Cargo.lock"),
		'[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["serde"]\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
	);
	const serde = join(f.cargoHome, "registry", "src", "index.crates.io-1949cf8c6b5b557f", "serde-1.0.200");
	await mkdir(serde, { recursive: true });
	await writeFile(
		join(f.project, "package.json"),
		JSON.stringify({ dependencies: { "@scope/pkg": "^1" }, devDependencies: { missing: "1" } }),
	);
	await writeFile(join(f.project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	const store = join(f.project, "node_modules", ".pnpm", "@scope+pkg@1.2.3", "node_modules", "@scope", "pkg");
	await mkdir(store, { recursive: true });
	await writeFile(join(store, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }));
	await mkdir(join(f.project, "node_modules", "@scope"), { recursive: true });
	await symlink(store, join(f.project, "node_modules", "@scope", "pkg"));

	const first = await f.sources.resolve(f.project, f.project);
	assert.deepEqual(
		first.map(({ name, version, indirect, path }) => [name, version, !!indirect, path]),
		[
			["github.com/Azure/azure-sdk-for-go/sdk/azcore", "v1.24.0", false, azure],
			["github.com/stoikio/eventbus-schema/go", "v0.32.0", false, schema],
			["github.com/BurntSushi/toml", "v1.4.0", true, toml],
			["github.com/New/name", "v2.0.0", false, renamed],
			["serde", "1.0.200", false, serde],
			["@scope/pkg", "1.2.3", false, store],
		],
	);
	assert.equal(await f.sources.resolve(f.project, f.project), first, "unchanged lock files reuse the resolution");
	await writeFile(
		join(f.project, "go.mod"),
		"module example.com/service\n\nrequire github.com/stoikio/eventbus-schema/go v0.32.0\n",
	);
	await utimes(join(f.project, "go.mod"), new Date(), new Date(Date.now() + 5000));
	const next = await f.sources.resolve(f.project, f.project);
	assert.notEqual(next, first);
	assert.deepEqual(
		next.filter((source) => source.name.startsWith("github.com")).map((source) => source.path),
		[schema],
	);
});

test("projects without lock files have no dependency sources", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.project, "package.json"), JSON.stringify({ dependencies: { left: "1" } }));
	await mkdir(join(f.project, "node_modules", "left"), { recursive: true });
	await writeFile(join(f.project, "node_modules", "left", "package.json"), '{"name":"left","version":"1.0.0"}');
	assert.deepEqual(await f.sources.resolve(f.project, f.project), []);
});
