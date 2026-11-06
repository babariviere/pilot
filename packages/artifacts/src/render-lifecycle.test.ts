import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("retired paths reject without loading compilers or starting processes and workers", () => {
	const source = `
const assert = (await import('node:assert/strict')).default;
const { registerHooks, syncBuiltinESMExports } = await import('node:module');
const attempts = [];
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^(glslang-wasm-validator|playwright|puppeteer|esbuild)(\\/|$)/.test(specifier)) {
    attempts.push(specifier);
    throw new Error('UNEXPECTED COMPILER OR BROWSER');
  }
  return nextResolve(specifier, context);
} });
const child = (await import('node:child_process')).default;
for (const name of ['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync', 'fork']) {
  child[name] = () => { attempts.push(name); throw new Error('UNEXPECTED CHILD PROCESS'); };
}
const workers = (await import('node:worker_threads')).default;
workers.Worker = class { constructor() { attempts.push('Worker'); throw new Error('UNEXPECTED WORKER'); } };
syncBuiltinESMExports();
const { prepareArtifact, previewArtifact } = await import('./index.ts');
for (const kind of ['html', 'react', 'swiftui']) {
  for (const run of [prepareArtifact, previewArtifact]) {
    try { await run({title:'Legacy', kind, source:'while(true){}'}); throw new Error('ACCEPTED'); }
    catch (error) { if (!error.message.includes('Supported kinds: image, visual, shader')) throw error; }
  }
}
assert.deepEqual(attempts, []);
console.log('rejected-without-execution');
`;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: new URL(".", import.meta.url),
		timeout: 15_000,
		encoding: "utf8",
	});
	assert.match(output, /rejected-without-execution/);
});
