import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactLibraries, getLibrary, isArtifactLibrary, prepareArtifact, validateArtifact } from "./render.ts";

test("HTML receives its policy before agent content and only requested offline libraries", async () => {
	const { html, libraries } = await prepareArtifact({
		title: "chart",
		kind: "html",
		source: "<script>console.log(1)</script>",
		libraries: ["echarts", "echarts"],
	});
	assert.deepEqual(libraries, ["echarts"]);
	assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("console.log"));
	assert.match(html, /connect-src 'none'/);
	assert.match(html, /worker-src 'none'/);
	assert.match(html, /pilot-artifact:\/\/library\/echarts/);
	assert.doesNotMatch(html, /library\/three/);
	assert.equal(isArtifactLibrary("__proto__"), false);
	assert.equal(isArtifactLibrary("three"), true);
});

test("JSX/TSX compilation supports bundled imports and rejects arbitrary packages or files", async () => {
	const prepared = await prepareArtifact({
		title: "React",
		kind: "react",
		source:
			'import {useState} from "react"; import {motion} from "motion/react"; export default function Artifact(){const [n,setN]=useState<number>(0);return <motion.button animate={{opacity:1}} onClick={()=>setN(n+1)}>{n}</motion.button>}',
	});
	assert.match(prepared.html, /artifact-root/);
	assert.doesNotMatch(prepared.html, /import \{useState\}/);
	for (const name of ["node:fs", "https://example.com/a.js", "./file.ts", "lodash"]) {
		await assert.rejects(
			prepareArtifact({
				title: "bad",
				kind: "react",
				source: `import thing from ${JSON.stringify(name)}; export default function A(){return <div>{thing}</div>}`,
			}),
			/not available/,
		);
	}
	await assert.rejects(
		prepareArtifact({ title: "missing export", kind: "react", source: "export const x=1" }),
		/default/,
	);
});

test("documents are validated and React DOM uses the shared React runtime", async () => {
	assert.throws(() => validateArtifact({ title: "", kind: "html", source: "x" }), /title/);
	assert.throws(() => validateArtifact({ title: "x", kind: "html", source: "x".repeat(512 * 1024 + 1) }), /512/);
	const normalized = validateArtifact({ title: "x", kind: "html", source: "x", libraries: ["react-dom"] });
	assert.deepEqual(normalized.libraries, ["react", "react-dom"]);
	assert.deepEqual(
		validateArtifact({ title: "x", kind: "html", source: "x", libraries: ["react-dom", "react"] }).libraries,
		["react", "react-dom"],
	);
	for (const name of Object.keys(artifactLibraries)) {
		assert.ok(isArtifactLibrary(name));
		assert.ok((await getLibrary(name)).length > 100);
	}
});
