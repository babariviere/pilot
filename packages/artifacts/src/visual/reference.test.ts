/**
 * The agent-facing reference (skills/pilot-artifacts/references/visual.d.ts and visuals.md in the kernel) is written
 * by hand for agents to read. These tests keep it in step with the runtime: every ui function, prop, pen call, style
 * and token it declares exists, and nothing the runtime accepts is missing; the quoted limits match schema.ts; and the
 * examples pass the publication check.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { runVisualCheck } from "./check.ts";
import { checkVisual } from "./index.ts";
import { VISUAL_COLORS, VISUAL_LIMITS, VISUAL_TEXT_SIZES, VISUAL_WEIGHTS } from "./schema.ts";
import { visualRuntime } from "./session.ts";

const references = new URL("../../../kernel/skills/pilot-artifacts/references/", import.meta.url);
const declarations = () => readFile(new URL("visual.d.ts", references), "utf8");
const guide = () => readFile(new URL("visuals.md", references), "utf8");

async function check(source: string, data: unknown = null) {
	return runVisualCheck({
		wasm: await loadQuickJSWasm(),
		runtime: await visualRuntime(),
		source,
		data: JSON.stringify(data),
		seed: "reference",
		now: 0,
	});
}

/** The error of a visual that must fail. */
async function failure(source: string): Promise<string> {
	const result = await check(source);
	assert.equal(result.ok, false, source);
	return (result as { error: string }).error;
}

/** The first console line of a visual that must pass. */
async function logged(source: string): Promise<string> {
	const result = await check(source);
	assert.ok(result.ok, JSON.stringify(result));
	return result.report.logs[0] ?? "";
}

/** The names listed after "allowed:" in an unknown prop or style error. */
function allowed(error: string): string[] {
	const list = error.match(/\(allowed: ([^)]*)\)/)?.[1];
	assert.ok(list, error);
	return list.split(", ").sort();
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The body of interface name, comments removed. */
function body(dts: string, name: string): string {
	const text = withoutComments(dts);
	const start = text.indexOf(`interface ${name} {`);
	assert.ok(start >= 0, `visual.d.ts has no interface ${name}`);
	let depth = 0;
	for (let index = text.indexOf("{", start); index < text.length; index++) {
		if (text[index] === "{") depth++;
		else if (text[index] === "}" && --depth === 0) return text.slice(text.indexOf("{", start) + 1, index);
	}
	throw new Error(`interface ${name} is not closed`);
}

/** Property names of the object types directly in text (not nested objects, not function parameters). */
function objectProps(text: string): string[] {
	let braces = 0;
	let parens = 0;
	let open = 0;
	let flat = "";
	for (const char of text) {
		if (char === "{" && braces++ === 0) open = parens;
		else if (char === "}") braces--;
		else if (char === "(") parens++;
		else if (char === ")") parens--;
		flat += braces === 1 && parens === open && char !== "{" ? char : " ";
	}
	return [...flat.matchAll(/(\w+)\??\s*:/g)].map((match) => match[1]!);
}

/** Each method of an interface body with the text of its parameters, overloads merged. */
function methods(text: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const match of text.matchAll(/^\t(\w+)\(/gm)) {
		const start = match.index + match[0].length;
		let depth = 1;
		let end = start;
		while (depth > 0 && end < text.length) {
			if (text[end] === "(") depth++;
			else if (text[end] === ")") depth--;
			end++;
		}
		result.set(match[1]!, `${result.get(match[1]!) ?? ""} ${text.slice(start, end - 1)}`);
	}
	return result;
}

/** The members of a string or number literal union type. */
function union(dts: string, name: string): string[] {
	const declaration = withoutComments(dts).match(new RegExp(`type ${name} =([^;]*);`))?.[1];
	assert.ok(declaration, `visual.d.ts has no type ${name}`);
	return [...declaration.matchAll(/"([^"]*)"|(\d+)/g)].map((match) => match[1] ?? match[2]!);
}

/** A source that calls ui.name with an unknown prop, so the error lists the allowed ones. */
const unknownProp: Record<string, string> = {
	column: "ui.column({ zzz: 1 }, [])",
	row: "ui.row({ zzz: 1 }, [])",
	grid: "ui.grid({ zzz: 1 }, [])",
	text: 'ui.text("x", { zzz: 1 })',
	span: 'ui.text([ui.span("x", { zzz: 1 })])',
	link: 'ui.link("x", { zzz: 1 })',
	space: "ui.space({ zzz: 1 })",
	mermaid: 'ui.mermaid("graph TD", { zzz: 1 })',
};

test("visual.d.ts declares every ui function and exactly the props the runtime accepts", async () => {
	const ui = methods(body(await declarations(), "UI"));
	const names = (await logged('({ ui }) => { console.log(Object.keys(ui).join(",")); return () => ui.text("x"); }'))
		.split(",")
		.sort();
	assert.deepEqual([...ui.keys()].sort(), names);
	for (const [name, params] of ui) {
		const declared = [...new Set(objectProps(params))].sort();
		const error = await failure(`({ ui }) => () => ${unknownProp[name] ?? `ui.${name}({ zzz: 1 })`}`);
		if (/not yet supported/.test(error)) {
			assert.deepEqual(declared, [], `${name} is unsupported but declares props`);
			continue;
		}
		assert.deepEqual(declared, allowed(error), `props of ui.${name}`);
	}
});

test("visual.d.ts declares every pen call, style and frame field the runtime accepts", async () => {
	const dts = await declarations();
	const pen = methods(body(dts, "Pen"));
	const paint = objectProps(`{${body(dts, "Paint")}}`);
	const canvas = (draw: string) => `({ ui }) => () => ui.canvas({ draw: (g, frame) => { ${draw} } })`;
	const once = (line: string) => `if (frame.width === 760 && !frame.pointer) console.log(${line});`;
	assert.deepEqual([...pen.keys()].sort(), (await logged(canvas(once('Object.keys(g).join(",")')))).split(",").sort());
	assert.deepEqual(
		objectProps(`{${body(dts, "Frame")}}`).sort(),
		(await logged(canvas(once('Object.keys(frame).join(",")')))).split(",").sort(),
	);
	const styled: Record<string, string> = {
		rect: "g.rect(0, 0, 1, 1, { zzz: 1 })",
		circle: "g.circle(0, 0, 1, { zzz: 1 })",
		line: "g.line(0, 0, 1, 1, { zzz: 1 })",
		path: "g.path([0, 0, 1, 1], { zzz: 1 })",
		arc: "g.arc(0, 0, 1, 0, 1, { zzz: 1 })",
		text: 'g.text(0, 0, "x", { zzz: 1 })',
	};
	for (const [name, call] of Object.entries(styled)) {
		const params = pen.get(name);
		assert.ok(params, `visual.d.ts has no g.${name}`);
		const declared = new Set(objectProps(params));
		if (params.includes("Paint")) for (const prop of paint) declared.add(prop);
		assert.deepEqual([...declared].sort(), allowed(await failure(canvas(call))), `styles of g.${name}`);
	}
});

test("visual.d.ts tokens and the quoted limits match schema.ts", async () => {
	const dts = await declarations();
	assert.deepEqual(union(dts, "Color"), [...VISUAL_COLORS]);
	assert.deepEqual(union(dts, "TextSize"), [...VISUAL_TEXT_SIZES]);
	assert.deepEqual(union(dts, "Weight").map(Number), [...VISUAL_WEIGHTS]);
	const text = `${dts}\n${await guide()}`;
	const count = (value: number) => value.toLocaleString("en-US");
	for (const quoted of [
		`${count(VISUAL_LIMITS.drawCommands)} per frame`,
		`${count(VISUAL_LIMITS.drawPoints)} path points`,
		`${VISUAL_LIMITS.drawTextChars / 1024} KiB of text`,
		`${VISUAL_LIMITS.drawMs} ms per frame`,
		`| Canvas draw | ${VISUAL_LIMITS.drawMs} ms; ${count(VISUAL_LIMITS.drawCommands)} commands |`,
		`| Setup, view | ${VISUAL_LIMITS.setupMs} ms each |`,
		`| Handler | ${VISUAL_LIMITS.handlerMs} ms |`,
		`| Tree | ${count(VISUAL_LIMITS.nodes)} nodes, ${VISUAL_LIMITS.textChars / 1024} KiB of text |`,
		`| Heap | ${VISUAL_LIMITS.heapBytes / 1024 / 1024} MiB |`,
		`| Source | ${VISUAL_LIMITS.sourceBytes / 1024} KiB |`,
		`up to ${VISUAL_LIMITS.interactions} interactions`,
	])
		assert.ok(text.includes(quoted), `the reference does not say "${quoted}"`);
});

test("the examples in visuals.md pass the publication check", async () => {
	const blocks = [...(await guide()).matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]!);
	const visuals = blocks.map((block) => block.match(/^function visual[\s\S]*?^}$/m)?.[0]).filter(Boolean) as string[];
	assert.ok(visuals.length >= 2, "visuals.md has no function visual examples");
	const [visual, ...others] = visuals as [string, ...string[]];
	const rows = [
		{ region: "eu", p95: 120, p99: 180 },
		{ region: "us", p95: 140, p99: 210 },
	];
	const main = await check(visual, rows);
	assert.ok(main.ok, JSON.stringify(main));
	// The other function examples (the Mermaid one) need no data.
	for (const other of others) {
		const result = await check(other);
		assert.ok(result.ok, JSON.stringify(result));
	}
	assert.ok(
		others.some((other) => other.includes("ui.mermaid(")),
		"visuals.md has no ui.mermaid example",
	);
	const canvas = blocks.find((block) => block.startsWith("ui.canvas("));
	assert.ok(canvas, "visuals.md has no ui.canvas example");
	const drawn = await check(`({ ui }) => () => ${canvas.trim()}`);
	assert.ok(drawn.ok, JSON.stringify(drawn));
	assert.equal(drawn.report.draws, 8);
	const shader = blocks.find((block) => block.startsWith("ui.shader("));
	assert.ok(shader, "visuals.md has no ui.shader example");
	const shaded = await checkVisual({
		source: `({ ui, state }) => { const s = state({ speed: 1 }); return () => ${shader.trim()}; }`,
		data: "null",
		id: "reference",
	});
	assert.equal(shaded.shaders?.length, 1);
});
