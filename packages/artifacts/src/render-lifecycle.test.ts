import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("retired paths neither load compiler/browser dependencies nor launch child processes", () => {
	const source = `
const { syncBuiltinESMExports } = await import('node:module');
const child = (await import('node:child_process')).default;
for (const name of ['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync', 'fork']) {
  child[name] = () => { throw new Error('UNEXPECTED CHILD PROCESS'); };
}
syncBuiltinESMExports();
const { prepareArtifact, previewArtifact } = await import('./index.ts');
for (const kind of ['html', 'react', 'swiftui']) {
  for (const run of [prepareArtifact, previewArtifact]) {
    try { await run({title:'Legacy', kind, source:'while(true){}'}); throw new Error('ACCEPTED'); }
    catch (error) { if (!error.message.includes('Supported kinds: image, visual, shader')) throw error; }
  }
}
console.log('rejected-without-execution');
`;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: new URL(".", import.meta.url),
		timeout: 15_000,
		encoding: "utf8",
	});
	assert.match(output, /rejected-without-execution/);
});
