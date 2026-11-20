import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Day's NSH sources import protocol leaves by relative path and cannot resolve the SDK packages.
const source = new URL("./", import.meta.url);
const day = new URL("../../../apps/day/", import.meta.url);
const specifiers = (text: string) =>
	[...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
const leaves = new Set(
	readdirSync(source).filter((name) => name.endsWith(".ts") && name !== "index.ts" && !name.endsWith(".test.ts")),
);

test("protocol leaves import only other leaves; only agent-events names SDK types", () => {
	for (const leaf of leaves) {
		const text = readFileSync(new URL(leaf, source), "utf8");
		for (const specifier of specifiers(text)) {
			if (specifier.startsWith("./")) {
				assert.ok(leaves.has(specifier.slice(2)), `${leaf} imports non-leaf ${specifier}`);
				continue;
			}
			assert.ok(
				leaf === "agent-events.ts" && specifier.startsWith("@earendil-works/"),
				`${leaf} imports ${specifier}`,
			);
		}
		if (leaf === "agent-events.ts") {
			assert.doesNotMatch(text, /^import (?!type )/m, "agent-events imports types only");
			assert.doesNotMatch(text, /^export (?!type )/m, "agent-events exports types only");
		}
	}
});

test("protocol leaves that Day imports reach neither index.ts nor SDK types", () => {
	const reached = new Set<string>();
	const visit = (leaf: string) => {
		if (reached.has(leaf)) return;
		reached.add(leaf);
		for (const specifier of specifiers(readFileSync(new URL(leaf, source), "utf8")))
			if (specifier.startsWith("./")) visit(specifier.slice(2).replace(/(\.ts)?$/, ".ts"));
	};
	for (const name of readdirSync(day).filter((name) => /\.tsx?$/.test(name)))
		for (const specifier of specifiers(readFileSync(new URL(name, day), "utf8"))) {
			const leaf = /^\.\.\/\.\.\/packages\/protocol\/src\/([\w-]+)(?:\.ts)?$/.exec(specifier)?.[1];
			if (leaf) visit(`${leaf}.ts`);
		}
	assert.ok(reached.size > 0, "Day imports protocol leaves");
	for (const leaf of ["index.ts", "agent-events.ts"]) assert.ok(!reached.has(leaf), `Day reaches ${leaf}`);
});
