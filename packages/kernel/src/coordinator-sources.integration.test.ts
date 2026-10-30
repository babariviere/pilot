import assert from "node:assert/strict";
import fs, { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { getReadmePath, ModelRuntime, SettingsManager, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-durable";
import { ARTIFACT_SKILL_FILES } from "./artifact-skill.ts";
import type { CoordinatorSources } from "./coordinator-sources.ts";
import { NativeAdapter } from "./native-adapter.ts";

async function fixture(t: TestContext, mode = "off", withSkills = false) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-source-admission-")));
	const main = join(root, "main");
	const member = join(root, "member");
	const scratch = join(root, "scratch");
	const other = join(root, "other");
	const agentDir = join(root, "agent");
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
	});
	for (const path of [main, member, scratch, other, agentDir, `${main}-unrelated`]) await mkdir(path);
	const skillRoot = join(root, "personal-skills");
	const skillEntries: string[] = [];
	if (withSkills) {
		for (const name of ["chezmoi", "commit", "tldraw-offline", "rex"]) {
			const directory = join(skillRoot, name);
			await mkdir(join(directory, "references"), { recursive: true });
			const entry = join(directory, "SKILL.md");
			await writeFile(
				entry,
				`---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\nRead references/guide.md.\n`,
			);
			await writeFile(join(directory, "references", "guide.md"), `SELECTED_SKILL_REFERENCE_${name}`);
			skillEntries.push(entry);
		}
		// A host-selected symlinked bundle is usable, but its anchor cannot silently retarget later.
		await symlink(join(skillRoot, "rex"), join(main, "skill-alias"));
		skillEntries[3] = join(main, "skill-alias", "SKILL.md");
	}
	const resourcePaths = [...skillEntries];
	if (withSkills) {
		for (const [path, name] of [
			[join(root, "standalone.md"), "standalone"],
			[join(agentDir, "SKILL.md"), "container"],
		] as const) {
			await writeFile(
				path,
				`---\nname: ${name}\ndescription: Fixture exact-file skill.\n---\nSELECTED_EXACT_FILE\n`,
			);
			resourcePaths.push(path);
		}
	}
	let advertiseSkills = true;
	for (const path of [main, member]) {
		await writeFile(
			join(path, "entry.ts"),
			"export function entry() { return leaf(); }\nfunction leaf() { return 42; }\n",
		);
		await mkdir(join(path, ".git"));
		await writeFile(join(path, ".git", "config"), "private metadata");
	}
	await writeFile(join(other, "secret.ts"), "UNRELATED_SOURCE");
	await writeFile(join(`${main}-unrelated`, "secret.ts"), "UNRELATED_SOURCE");
	await writeFile(
		join(agentDir, "sandbox.json"),
		JSON.stringify({ mode, denyRead: [join(main, "private"), join(skillRoot, "commit", "references", "guide.md")] }),
	);
	await mkdir(join(main, "private"));
	await writeFile(join(main, "private", "denied.txt"), "CONFIG_DENIED");
	let scope: CoordinatorSources = { main, members: [{ sessionId: "member", path: member }], scratch };
	let admissions = 0;
	let hold: (() => Promise<void>) | undefined;
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	const adapter = await NativeAdapter.open({
		cwd: scratch,
		agentDir,
		projectTrusted: false,
		sessionFile: join(root, "native.session"),
		sessionId: "coordinator-test",
		coordinatorSources: async () => {
			admissions++;
			const snapshot = structuredClone(scope);
			await hold?.();
			return snapshot;
		},
		settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
		loaderOptions: {
			cwd: scratch,
			agentDir,
			noSkills: true,
			noContextFiles: true,
			additionalSkillPaths: resourcePaths,
			skillsOverride: (loaded) => (advertiseSkills ? loaded : { ...loaded, skills: [] }),
		},
		sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
	});
	t.after(async () => {
		await adapter.close();
		await rm(root, { recursive: true, force: true });
	});
	let sequence = 0;
	const execute = async (name: string, args: JsonObject) => {
		const id = `source-${sequence++}`;
		const toolCall = { type: "toolCall" as const, id, name, arguments: args };
		const assistantMessage = fauxAssistantMessage(toolCall, { stopReason: "toolUse" });
		adapter.session.agent.state.messages.push(assistantMessage);
		const definition = adapter.session.getToolDefinition(name)!;
		assert.ok(definition, name);
		const sourceInfo = adapter.session.getAllTools().find((tool) => tool.name === name)!.sourceInfo;
		try {
			// The same native admission hook used by the durable adapter, before direct execution.
			const admission = await adapter.session.agent.beforeToolCall?.({
				toolCall,
				args,
				assistantMessage,
				context: { messages: adapter.session.messages, tools: adapter.session.agent.state.tools },
			});
			if (admission?.block) throw new Error(admission.reason);
			return await wrapRegisteredTool({ definition, sourceInfo }, adapter.session.extensionRunner).execute(id, args);
		} catch (error) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: (error as Error).message }],
				details: undefined,
			};
		}
	};
	return {
		root,
		main,
		member,
		scratch,
		other,
		adapter,
		skillRoot,
		skillEntries,
		resourcePaths,
		agentDir,
		removeSkills: () => {
			advertiseSkills = false;
		},
		execute,
		admissions: () => admissions,
		revoke: () => {
			scope = { ...scope, members: [] };
		},
		hold: (callback?: () => Promise<void>) => {
			hold = callback;
		},
	};
}

test("host-advertised coordinator skills and bundle references remain readable direct and nested", async (t) => {
	const f = await fixture(t, "off", true);
	assert.deepEqual(
		f.adapter.session.resourceLoader.getSkills().skills.map((skill) => skill.filePath),
		f.resourcePaths,
	);
	for (const nested of [false, true]) {
		await t.test(nested ? "nested" : "direct", async () => {
			for (const path of f.skillEntries.flatMap((entry) => [
				entry,
				join(dirname(entry), "references", "guide.md"),
			])) {
				const result = await f.execute(
					nested ? "codemode" : "read",
					nested ? { code: `text(await tools.read({path:${JSON.stringify(path)}}));` } : { path },
				);
				assert.ok(!result.isError, JSON.stringify(result));
				assert.match(JSON.stringify(result), /Fixture skill|SELECTED_SKILL_REFERENCE/);
			}
		});
	}
	for (const path of [join(f.skillRoot, "rex", "references", "guide.md"), ...f.resourcePaths.slice(4)]) {
		const result = await f.execute("read", { path });
		assert.ok(!result.isError, JSON.stringify(result));
		assert.match(JSON.stringify(result), /SELECTED_SKILL_REFERENCE_rex|SELECTED_EXACT_FILE/);
	}
	const roots = await f.execute("source_roots", {});
	assert.deepEqual(Object.keys(roots.structuredContent!), ["main", "members", "scratch"]);
});

test("skill resources do not grant external references, parent roots, search or writes", async (t) => {
	const f = await fixture(t, "workspace-write", true);
	const downloads = join(f.root, "Downloads");
	await mkdir(downloads);
	const external = [
		join(downloads, "callstack.jpeg"),
		join(f.agentDir, "settings-secret.txt"),
		join(f.root, "standalone-neighbor.md"),
		join(f.skillRoot, "unadvertised", "SKILL.md"),
	];
	await mkdir(dirname(external[3]!), { recursive: true });
	for (const path of external) await writeFile(path, "UNGRANTED_SKILL_NEIGHBOR");
	const guide = join(f.skillRoot, "chezmoi", "references", "guide.md");
	await writeFile(guide, `SELECTED_SKILL_REFERENCE\nRead ${external[0]}.`);
	const deniedReference = join(f.skillRoot, "commit", "references", "guide.md");
	const calls = [
		...external.map((path) => ["read", { path }]),
		["read", { path: deniedReference }],
		["ls", { path: dirname(guide) }],
		["find", { path: f.skillRoot, pattern: "*" }],
		["grep", { path: f.skillRoot, pattern: "SELECTED" }],
		["code_search", { path: f.skillRoot, query: "SELECTED" }],
		["write", { path: guide, content: "mutated" }],
		["edit", { path: guide, oldText: "SELECTED", newText: "mutated" }],
		[
			"applyPatch",
			{ patch: `*** Begin Patch\n*** Add File: ${join(dirname(guide), "new.md")}\n+mutated\n*** End Patch` },
		],
	] as [string, JsonObject][];
	for (const [name, args] of calls) {
		const result = await f.execute(name, args);
		assert.ok(result.isError, `${name}: ${JSON.stringify(result)}`);
		assert.doesNotMatch(JSON.stringify(result.content), /UNGRANTED_SKILL_NEIGHBOR|SELECTED_SKILL_REFERENCE_commit/);
		if (name === "read" && external.includes(args.path as string))
			assert.match(JSON.stringify(result.content), /outside current main/);
	}
	const nested = await f.execute("codemode", {
		code: `
for (const [name,args] of ${JSON.stringify(calls)}) {
 try { text(await tools[name](args)); text('ESCAPED'); }
 catch { text('DENIED:'+name); }
}`,
	});
	assert.ok(!nested.isError, JSON.stringify(nested));
	assert.doesNotMatch(JSON.stringify(nested), /ESCAPED|UNGRANTED_SKILL_NEIGHBOR|SELECTED_SKILL_REFERENCE_commit/);
	assert.match(await readFile(guide, "utf8"), /^SELECTED_SKILL_REFERENCE/);
	await assert.rejects(readFile(join(dirname(guide), "new.md")), { code: "ENOENT" });
	assert.ok(!(await f.execute("read", { path: guide })).isError);
	assert.match(JSON.stringify(await f.execute("read", { path: deniedReference })), /denied by mode/);
});

test("skill references retain alias guards and resource reload revokes direct/nested reads", async (t) => {
	const f = await fixture(t, "off", true);
	const referenceDir = join(f.skillRoot, "chezmoi", "references");
	await symlink(join(f.other, "secret.ts"), join(referenceDir, "symlink.md"));
	await link(join(f.other, "secret.ts"), join(referenceDir, "hardlink.md"));
	await mkdir(join(f.skillRoot, "chezmoi", ".git"));
	await writeFile(join(f.skillRoot, "chezmoi", ".git", "config"), "UNRELATED_METADATA");
	for (const path of [
		join(referenceDir, "symlink.md"),
		join(referenceDir, "hardlink.md"),
		join(f.skillRoot, "chezmoi", ".git", "config"),
	]) {
		assert.ok((await f.execute("read", { path })).isError);
		const nested = await f.execute("codemode", {
			code: `try { text(await tools.read({path:${JSON.stringify(path)}})); text('ESCAPED'); } catch { text('DENIED'); }`,
		});
		assert.ok(!nested.isError, JSON.stringify(nested));
		assert.doesNotMatch(JSON.stringify(nested), /ESCAPED|UNRELATED_SOURCE|UNRELATED_METADATA/);
	}
	const alias = join(f.main, "skill-alias");
	await rm(alias);
	await symlink(f.other, alias);
	for (const path of [join(alias, "secret.ts"), join(f.skillRoot, "rex", "references", "guide.md")]) {
		const result = await f.execute("read", { path });
		assert.ok(result.isError);
		assert.doesNotMatch(JSON.stringify(result.content), /UNRELATED_SOURCE|SELECTED_SKILL_REFERENCE_rex/);
	}
	await f.adapter.session.reload();
	assert.ok(!(await f.execute("read", { path: f.skillEntries[0]! })).isError, "reload retains selected resources");
	f.removeSkills();
	await f.adapter.session.reload();
	assert.equal(f.adapter.session.resourceLoader.getSkills().skills.length, 0);
	const path = join(referenceDir, "guide.md");
	assert.ok((await f.execute("read", { path })).isError);
	const nested = await f.execute("codemode", {
		code: `try { text(await tools.read({path:${JSON.stringify(path)}})); text('ESCAPED'); } catch { text('REVOKED'); }`,
	});
	assert.ok(!nested.isError, JSON.stringify(nested));
	assert.match(JSON.stringify(nested), /REVOKED/);
	assert.doesNotMatch(JSON.stringify(nested), /ESCAPED|SELECTED_SKILL_REFERENCE/);
});

test("coordinator native direct/nested source tools use current owned roots, not scratch cwd", async (t) => {
	const f = await fixture(t);
	for (const [name, args] of [
		["read", { path: "entry.ts" }],
		["read", { path: join(f.member, "entry.ts") }],
		["ls", { path: f.member }],
		["find", { path: f.member, pattern: "*.ts" }],
		["grep", { path: f.member, pattern: "return 42" }],
		["code_search", { path: f.member, query: "return 42" }],
		["code_symbols", { path: f.member, query: "entry", exact: true }],
		["code_call_paths", { path: f.member, symbol: { path: "entry.ts", line: 1, column: 17 }, direction: "callees" }],
	] as const) {
		const result = await f.execute(name, args);
		assert.ok(!result.isError, JSON.stringify(result));
		assert.match(JSON.stringify(result), /entry|leaf|return 42/);
	}
	const nested = await f.execute("codemode", {
		code: `
const roots = await tools.source_roots({}); text(roots.members[0].sessionId);
text(await tools.read({path:${JSON.stringify(join(f.member, "entry.ts"))}}));
text((await tools.code_symbols({query:"entry",exact:true})).results[0].name);
`,
	});
	assert.ok(!nested.isError, JSON.stringify(nested));
	assert.match(JSON.stringify(nested), /member.*entry/s);
	assert.ok(f.admissions() >= 11);
	for (const path of [getReadmePath(), ARTIFACT_SKILL_FILES[0]!])
		assert.ok(!(await f.execute("read", { path, limit: 1 })).isError);
	await writeFile(join(f.scratch, "notes.txt"), "scratch notes");
	assert.match(JSON.stringify(await f.execute("read", { path: join(f.scratch, "notes.txt") })), /scratch notes/);
	await f.adapter.session.reload();
	assert.ok(!(await f.execute("read", { path: "entry.ts" })).isError, "reload retains IPC-backed source admission");
});

test("coordinator native source admission refuses unrelated roots, traversal, metadata and aliases", async (t) => {
	const f = await fixture(t);
	await symlink(f.other, join(f.member, "escape"));
	await symlink(f.member, join(f.root, "member-alias"));
	await symlink("entry.ts", join(f.member, "internal.ts"));
	await link(join(f.other, "secret.ts"), join(f.member, "hardlink.ts"));
	for (const path of [
		join(f.other, "secret.ts"),
		join(`${f.main}-unrelated`, "secret.ts"),
		join(f.member, "escape", "secret.ts"),
		join(f.root, "member-alias", "entry.ts"),
		join(f.member, "internal.ts"),
		join(f.member, "hardlink.ts"),
		`${f.member}/../member/entry.ts`,
		join(f.member, ".git", "config"),
		join(f.member, ".GIT", "config"),
		join(f.member, ".JJ", "repo"),
	]) {
		const result = await f.execute("read", { path });
		assert.ok(result.isError, `${path}: ${JSON.stringify(result)}`);
		assert.doesNotMatch(JSON.stringify(result.content), /UNRELATED_SOURCE|private metadata/);
	}
	const nested = await f.execute("codemode", {
		code: `
for (const name of ['read','ls','find','grep','code_search','code_symbols','code_call_paths']) {
  try { await tools[name]({path:${JSON.stringify(f.other)},pattern:'*',query:'UNRELATED_SOURCE',symbol:{path:'secret.ts',line:1,column:1},direction:'callees'}); text('ESCAPED:'+name); }
  catch { text('denied:'+name); }
}`,
	});
	assert.ok(!nested.isError, JSON.stringify(nested));
	assert.doesNotMatch(JSON.stringify(nested), /ESCAPED/);
	for (const name of ["read", "ls", "find", "grep", "code_search", "code_symbols", "code_call_paths"])
		assert.match(JSON.stringify(nested), new RegExp(`denied:${name}`));
	const scan = await f.execute("code_search", { path: f.member, query: "UNRELATED_SOURCE" });
	assert.ok(!scan.isError, JSON.stringify(scan));
	assert.equal(
		(scan.structuredContent as { results: unknown[] }).results.length,
		0,
		"scanner cannot read hardlink bytes",
	);
	// The host supplied canonical roots. Replacing a root after admission must not rebind it through a symlink.
	await rename(f.member, `${f.member}-owned`);
	await symlink(f.other, f.member);
	const replaced = await f.execute("read", { path: join(f.member, "secret.ts") });
	assert.ok(replaced.isError);
	assert.doesNotMatch(JSON.stringify(replaced.content), /UNRELATED_SOURCE/);
});

test("revocation blocks fresh direct/nested calls while an admitted finite read may drain", async (t) => {
	const f = await fixture(t);
	let admitted!: () => void;
	const started = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	let release!: () => void;
	const drain = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.hold(async () => {
		admitted();
		await drain;
	});
	const request = f.execute("read", { path: join(f.member, "entry.ts") });
	await started;
	f.revoke();
	f.hold();
	release();
	assert.ok(!(await request).isError);
	assert.ok((await f.execute("read", { path: join(f.member, "entry.ts") })).isError);
	const nested = await f.execute("codemode", {
		code: `try { await tools.read({path:${JSON.stringify(join(f.member, "entry.ts"))}}); text('ESCAPED'); } catch { text('REVOKED'); }`,
	});
	assert.match(JSON.stringify(nested), /REVOKED/);
	assert.doesNotMatch(JSON.stringify(nested), /ESCAPED/);
});

test("native direct/nested hardlink and changed-parent requests disclose no target bytes", async (t) => {
	const f = await fixture(t);
	const target = join(f.other, "payload.ts");
	await writeFile(target, "function forbidden() { return 'FORBIDDEN_PAYLOAD_7'; }\n");
	const alias = join(f.member, "hardlink.ts");
	await link(target, alias);
	for (const nested of [false, true]) {
		for (const name of ["read", "ls", "find", "grep", "code_search", "code_symbols", "code_call_paths"]) {
			const args = {
				path: alias,
				pattern: "forbidden",
				query: "forbidden",
				symbol: { path: "hardlink.ts", line: 1, column: 10 },
				direction: "callees",
			};
			const result = await f.execute(
				nested ? "codemode" : name,
				nested
					? {
							code: `try { text(await tools.${name}(${JSON.stringify(args)})); } catch (e) { text(String(e)); }`,
						}
					: args,
			);
			assert.doesNotMatch(JSON.stringify(result), /FORBIDDEN_PAYLOAD_7/, `${nested}:${name}`);
		}
	}
	const parent = join(f.member, "parent");
	await mkdir(parent);
	await writeFile(join(parent, "payload.ts"), "OWNED_SOURCE");
	await rename(parent, `${parent}-owned`);
	await symlink(f.other, parent);
	for (const nested of [false, true]) {
		for (const name of ["read", "ls", "find", "grep", "code_search", "code_symbols", "code_call_paths"]) {
			const args = {
				path: name === "read" ? join(parent, "payload.ts") : parent,
				pattern: "forbidden",
				query: "forbidden",
				symbol: { path: "parent/payload.ts", line: 1, column: 10 },
				direction: "callees",
			};
			const result = await f.execute(
				nested ? "codemode" : name,
				nested
					? {
							code: `try { text(await tools.${name}(${JSON.stringify(args)})); } catch (e) { text(String(e)); }`,
						}
					: args,
			);
			assert.doesNotMatch(JSON.stringify(result), /FORBIDDEN_PAYLOAD_7/, `${nested}:${name}`);
		}
	}
});

test("persistent parent swaps between preflight and open/list are detected at the native boundary", async (t) => {
	for (const nested of [false, true])
		for (const name of ["read", "grep", "find", "ls"])
			await t.test(`${nested ? "nested" : "direct"} ${name}`, async (t) => {
				const f = await fixture(t);
				const parent = join(f.member, "parent");
				await mkdir(parent);
				await writeFile(join(parent, "payload.ts"), "OWNED_SOURCE");
				await writeFile(join(f.other, "payload.ts"), "FORBIDDEN_PAYLOAD_7");
				const method = ["read", "grep"].includes(name) ? "open" : "opendir";
				const original = fs[method];
				let intercepted = false;
				const mock = t.mock.method(fs, method, async (...args: unknown[]) => {
					const path = String(args[0]);
					if (!intercepted && (path === parent || path === join(parent, "payload.ts"))) {
						intercepted = true;
						await rename(parent, `${parent}-owned`);
						await symlink(f.other, parent);
					}
					return Reflect.apply(original, fs, args);
				});
				syncBuiltinESMExports();
				try {
					const args = { path: name === "read" ? join(parent, "payload.ts") : parent, pattern: "FORBIDDEN_" };
					const result = await f.execute(
						nested ? "codemode" : name,
						nested
							? {
									code: `try { text(await tools.${name}(${JSON.stringify(args)})); text('ACCEPTED'); } catch { text('DENIED'); }`,
								}
							: args,
					);
					assert.ok(intercepted, "fixture must mutate the actual filesystem-open boundary");
					assert.doesNotMatch(JSON.stringify(result), /FORBIDDEN_PAYLOAD_7|ACCEPTED/);
					if (!nested) assert.ok(result.isError, JSON.stringify(result));
				} finally {
					mock.mock.restore();
					syncBuiltinESMExports();
				}
			});
});

test("configured sandbox read denials and scratch-only native writes survive the coordinator profile", async (t) => {
	const f = await fixture(t, "workspace-write");
	assert.ok((await f.execute("read", { path: join(f.main, "private", "denied.txt") })).isError);
	assert.ok((await f.execute("find", { path: f.main, pattern: "*" })).isError);
	assert.ok((await f.execute("code_symbols", { query: "entry" })).isError);
	assert.ok(!(await f.execute("read", { path: join(f.member, "entry.ts") })).isError);
	assert.ok((await f.execute("write", { path: join(f.member, "entry.ts"), content: "mutated" })).isError);
	assert.ok((await f.execute("edit", { path: join(f.main, "entry.ts"), oldText: "42", newText: "1" })).isError);
	assert.ok(!(await f.execute("write", { path: join(f.scratch, "notes.txt"), content: "notes" })).isError);
	await symlink(f.member, join(f.scratch, "escape"));
	await link(join(f.member, "entry.ts"), join(f.scratch, "alias.ts"));
	for (const path of [
		join(f.scratch, "escape", "entry.ts"),
		join(f.scratch, "alias.ts"),
		`${f.scratch}/../scratch/notes.txt`,
		"relative.txt",
	])
		assert.ok((await f.execute("write", { path, content: "mutated" })).isError, path);
	for (const path of [join(f.member, "patch.txt"), join(f.scratch, "escape", "patch.txt")])
		assert.ok(
			(await f.execute("applyPatch", { patch: `*** Begin Patch\n*** Add File: ${path}\n+mutated\n*** End Patch` }))
				.isError,
		);
	assert.ok(
		!(
			await f.execute("applyPatch", {
				patch: `*** Begin Patch\n*** Add File: ${join(f.scratch, "patch.txt")}\n+scratch patch\n*** End Patch`,
			})
		).isError,
	);
	assert.match(await readFile(join(f.member, "entry.ts"), "utf8"), /return 42/);
	const nested = await f.execute("codemode", {
		code: `
for (const [name,args] of ${JSON.stringify([
			["write", { path: join(f.member, "entry.ts"), content: "mutated" }],
			["edit", { path: join(f.main, "entry.ts"), oldText: "42", newText: "1" }],
			["write", { path: join(f.main, ".git", "config"), content: "mutated" }],
			[
				"applyPatch",
				{ patch: `*** Begin Patch\n*** Add File: ${join(f.member, "nested.txt")}\n+mutated\n*** End Patch` },
			],
		])}) {
  try { await tools[name](args); text('MUTATION_ALLOWED'); } catch { text('denied:'+name); }
}`,
	});
	assert.ok(!nested.isError, JSON.stringify(nested));
	assert.doesNotMatch(JSON.stringify(nested), /MUTATION_ALLOWED/);
	assert.match(await readFile(join(f.main, ".git", "config"), "utf8"), /private metadata/);
});

test("a sibling source override cannot bypass coordinator admission even with sandbox mode off", async (t) => {
	const f = await fixture(t);
	let ran = false;
	f.adapter.registerHostTool({
		...f.adapter.session.getToolDefinition("read")!,
		async execute() {
			ran = true;
			return { content: [{ type: "text", text: "UNCHECKED_SOURCE" }], details: undefined };
		},
	});
	const result = await f.execute("codemode", {
		code: `try { text(await tools.read({path:${JSON.stringify(join(f.other, "secret.ts"))}})); } catch { text('OVERRIDE_DENIED'); }`,
	});
	assert.match(JSON.stringify(result), /OVERRIDE_DENIED/);
	assert.doesNotMatch(JSON.stringify(result), /UNCHECKED_SOURCE/);
	assert.equal(ran, false);
});

test("native-only source scope does not disable or grant sources to existing bash/jobs", async (t) => {
	const f = await fixture(t);
	const before = f.admissions();
	const shell = await f.execute("bash", { command: "printf general-shell-ok" });
	assert.ok(!shell.isError, JSON.stringify(shell));
	assert.match(JSON.stringify(shell), /general-shell-ok/);
	const job = await f.execute("jobs", { action: "start", name: "existing tool", command: "printf general-job-ok" });
	assert.ok(!job.isError, JSON.stringify(job));
	const id = (job.structuredContent as { id: string }).id;
	const finished = await f.execute("jobs", { action: "wait", id, waitMs: 5000 });
	assert.equal((finished.structuredContent as { state: string }).state, "done");
	assert.equal(f.admissions(), before, "no new source permission is attached to arbitrary process calls");
});
