#!/usr/bin/env bash
# Run after copying and again after ZIP extraction in CI to catch non-relocatable dependencies.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$(cd "${1:?Usage: check-runtime.sh runtime}" && pwd)"
python3 "$here/scripts/release_metadata.py" symlinks "$runtime"
cd "$runtime"
./node/bin/node packages/daemon/scripts/build-usage-worker.mjs check packages/daemon/src
# No loader: pilotd uses native TS stripping; accounting's leaf worker is generated JS.
./node/bin/node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(Number(process.versions.node.split('.')[0]), 24);
await import('@pilot/kernel');
// Exercise Pi's TS extension loader from the staged installation, with no personal configuration.
const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
const { InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
const { EmbeddedResourceLoader } = await import('@babariviere/pi-extensions/resource-loader');
const { bundledAskTools, installBundledAnthropicAuth, ANTHROPIC_AUTH_PATH, CHILD_PROFILE_PATH } = await import('./packages/kernel/src/bundled-extensions.ts');
const { NativeAdapter } = await import('./packages/kernel/src/native-adapter.ts');
const { createTodoTool } = await import('./packages/kernel/src/todo-tool.ts');
const { fauxProvider } = await import('@earendil-works/pi-ai');
const isolated = await mkdtemp(join(tmpdir(), 'pilot-runtime-profile-'));
const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = isolated;
let parent;
globalThis.fetch = () => { throw new Error('Runtime profile smoke test must stay offline'); };
try {
  const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
  const writer = await import(new URL('./extensions/mcp/config-writer.js', sdk).href);
  assert.equal(writer.mcpConfigWriteProtocol, 1, 'Coordinated MCP writer patch is missing');
  const config = await import(new URL('./bundle/chunks/chunk-INGZIYBC.js', sdk).href);
  const mcpPath = join(isolated, 'mcp.json');
  config.addMcpServerConfig(mcpPath, 'fixture', { url: 'https://example.test/mcp' });
  const { McpSetupStore } = await import('./packages/daemon/src/mcp-setup.ts');
  const setup = new McpSetupStore(isolated), baseline = await setup.read();
  const saved = await setup.apply({ expectedRevision: baseline.revision,
    entries: [{ name: 'second', config: { url: 'https://example.test/mcp' } }] });
  assert.deepEqual(saved.entries.map(entry => entry.name), ['fixture', 'second']);
  config.removeMcpServerConfig(mcpPath, 'fixture');
  config.removeMcpServerConfig(mcpPath, 'second');
  const options = { cwd: isolated, agentDir: isolated, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true };
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider();
  models.registerNativeProvider(faux.provider);
  parent = await NativeAdapter.open({ cwd: isolated, agentDir: isolated, projectTrusted: false, sessionId: 'runtime-profile', hostTools: [createTodoTool(async () => [], () => 'runtime-profile')], sessionFile: join(isolated, 'native.jsonl'), settingsManager: SettingsManager.inMemory(), sessionOptions: { modelRuntime: models, model: faux.getModel() } });
  const names = loader => loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
  for (const name of ['applyPatch', 'web', 'browser', 'todo', 'jobs', 'subagent', 'code_call_paths', 'code_search', 'code_symbols']) assert.ok(parent.session.getCallableToolNames().includes(name), name);
  await writeFile(join(isolated, 'fixture.tsx'), 'export const RuntimeFixture = () => <button />;');
  const { runExploration } = await import('./packages/kernel/src/exploration-runner.ts');
  const explored = await runExploration({ source: isolated }, { tool: 'code_symbols', path: 'fixture.tsx', query: 'RuntimeFixture', exact: true });
  assert.equal(explored.results[0]?.name, 'RuntimeFixture');
  assert.equal(explored.results[0]?.coverage, 'parsed');
  const calls = await runExploration({ source: isolated }, { tool: 'code_call_paths', symbol: { path: 'fixture.tsx', line: 1, column: 14 }, direction: 'callees' });
  assert.equal(calls.mode, 'source-inferred-not-runtime');
  assert.equal(calls.root.name, 'RuntimeFixture');
  const child = new EmbeddedResourceLoader(options, { requiredPaths: [CHILD_PROFILE_PATH, ANTHROPIC_AUTH_PATH], ownedPackages: {} });
  await child.reload();
  assert.deepEqual(child.getExtensions().errors, []);
  assert.ok(names(child).includes('web'));
  assert.ok(!names(child).includes('jobs') && !names(child).includes('subagent'));
  assert.deepEqual((await bundledAskTools(isolated, isolated)).map(tool => tool.name), ['web']);
  await installBundledAnthropicAuth(models, isolated);
  assert.equal(typeof models.getRegisteredProviderConfig('anthropic')?.streamSimple, 'function');
} finally {
  await parent?.close();
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(isolated, { recursive: true, force: true });
}
const { prepareArtifact, getLibrary } = await import('@pilot/artifacts');
const artifact = await prepareArtifact({
  title: 'Runtime smoke test',
  kind: 'react',
  source: 'export default function Artifact() { return <p>pilot-artifact-runtime-ok</p>; }',
});
assert.match(artifact.html, /artifact-root/);
assert.ok((await getLibrary('mermaid')).length > 0);
const { existsSync } = await import('node:fs');
assert.ok(existsSync('packages/artifacts/dist/libraries/manifest.json'), 'Prebuilt artifact libraries are missing');
await import('ws');
const pty = createRequire(import.meta.url)('node-pty');
const terminal = pty.spawn('/bin/echo', ['pilot-runtime-ok'], { cwd: process.cwd(), env: process.env });
let output = '';
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Bundled node-pty smoke test timed out')), 10000);
  terminal.onData(data => { output += data; });
  terminal.onExit(({exitCode}) => { clearTimeout(timeout); exitCode === 0 ? resolve() : reject(new Error(`pty exit ${exitCode}`)); });
});
assert.match(output, /pilot-runtime-ok/);
JS
# Native dependencies must not need Homebrew or checkout-local shared libraries.
while IFS= read -r -d '' binary; do
	if file "$binary" | grep -q 'Mach-O'; then
		lipo "$binary" -verify_arch arm64
		otool -arch arm64 -L "$binary" | awk '/^[[:space:]]/{print $1}' | while IFS= read -r dependency; do
			case "$dependency" in
				@*|/usr/lib/*|/System/Library/*) ;;
				*) echo "Non-system runtime library: $dependency ($binary)" >&2; exit 1 ;;
			esac
		done
	fi
done < <(find "$runtime" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -111 \) -print0)
