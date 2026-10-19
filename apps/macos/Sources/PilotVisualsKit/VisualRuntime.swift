// Generated from packages/artifacts/src/visual/runtime.js by apps/macos/scripts/tests/visual-runtime.test.mjs.
// Do not edit: run PILOT_UPDATE_VISUAL_RUNTIME=1 node --test apps/macos/scripts/tests/visual-runtime.test.mjs.

/// The shared visual runtime, byte for byte, as the kernel's publish-time pre-check runs it.
public enum VisualRuntime {
    public static let source = ##"""
/*
 * Pilot visual runtime, API 1.
 *
 * Shared verbatim by the kernel's publish-time pre-check (quickjs-wasi) and the app's helper (QuickJS-NG), so a
 * visual behaves the same in both. Evaluating this file as a script returns the host API object and defines no
 * globals of its own; it replaces Math.random, Date, performance and console with deterministic, bounded versions
 * and removes WeakRef and FinalizationRegistry.
 *
 * Host contract (every value crosses as a string, number, boolean, undefined or the visual function):
 * - Evaluate the agent's source as '"use strict";(' + source + "\n)" with the filename "visual.js", so the visual
 *   runs in strict mode and stack lines match the function's own lines.
 * - load(fn, source, dataJson, stateJson | undefined, seedText, nowMs): checks fn, then runs setup. stateJson is a
 *   value earlier returned by state(). seedText is the artifact id; Math.random is seeded from its hash.
 * - render(nowMs): runs the view and returns the tree as JSON: {"api":1,"root":Node}.
 * - event(id, valueJson, nowMs): runs a control's handler with the value and returns JSON
 *   {"changed":[state keys assigned]}. Call render() afterwards.
 * - state(): the reader state as JSON, at most limits.stateChars.
 * - logs(): console lines since the last call, as a JSON array of strings.
 * - draw(id, width, height, t, pointerX, pointerY): runs the draw function of canvas id (from the last tree) for a
 *   width x height point area at t seconds; pointerX and pointerY are numbers, or undefined without a pointer.
 *   Returns the number of commands it recorded; state is read-only meanwhile.
 * - frame(): the commands of the last draw as { ops: Float64Array, strings: string[] }, encoded as DRAW_FORMAT
 *   below describes. frameJson() returns the same as JSON, with ops as an array, for tests.
 * Errors are thrown as exceptions. VisualError names a broken rule; the first "visual.js:LINE" frame of an error's
 * stack is the line inside the visual function.
 */
(() => {
	// biome-ignore lint/suspicious/noRedundantUseStrict: hosts evaluate this file as a script, not a module.
	"use strict";
	const API = 1;
	const LIMITS = Object.freeze({
		nodes: 5000,
		textChars: 64 * 1024,
		stateChars: 64 * 1024,
		logLines: 50,
		logLineChars: 500,
		drawCommands: 20000,
		drawPoints: 100000,
		drawTextChars: 64 * 1024,
		shaderChars: 16 * 1024,
		shaderInputs: 16,
	});
	const COLORS = [
		"text",
		"muted",
		"accent",
		"success",
		"warning",
		"danger",
		"border",
		"chart1",
		"chart2",
		"chart3",
		"chart4",
		"chart5",
		"chart6",
	];
	const SIZES = ["xs", "sm", "md", "lg", "xl"];
	const WEIGHTS = [400, 500, 600, 700];
	const TONES = ["neutral", "success", "warning", "danger"];
	const ALIGN = ["start", "center", "end"];
	const CHARTS = ["bar", "line", "area", "scatter"];

	// Captured before the visual runs, so the runtime keeps working when a visual replaces built-ins.
	const { freeze, keys, getPrototypeOf, prototype: ObjectPrototype } = Object;
	const hasOwn = Object.hasOwn;
	const isArray = Array.isArray;
	const { stringify, parse } = JSON;
	const finite = Number.isFinite;
	const isInteger = Number.isInteger;
	const RealDate = Date;
	const RealProxy = Proxy;
	const functionToString = Function.prototype.toString;
	const WeakMapRef = WeakMap;
	const Float64ArrayRef = Float64Array;
	const arrayFrom = Array.from;

	class VisualError extends Error {}
	VisualError.prototype.name = "VisualError";
	const fail = (message) => {
		throw new VisualError(message);
	};

	// Deterministic globals: the same visual builds the same tree in the kernel and in the app.
	let seed = 0;
	let now = 0;
	Math.random = function random() {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	function PilotDate(...args) {
		if (new.target === undefined) return new RealDate(now).toString();
		return args.length === 0 ? new RealDate(now) : new RealDate(...args);
	}
	PilotDate.prototype = RealDate.prototype;
	PilotDate.now = () => now;
	PilotDate.parse = RealDate.parse;
	PilotDate.UTC = RealDate.UTC;
	globalThis.Date = PilotDate;
	globalThis.performance = freeze({ now: () => 0 });
	delete globalThis.WeakRef;
	delete globalThis.FinalizationRegistry;

	let logLines = [];
	const show = (value) => {
		if (typeof value === "string") return value;
		try {
			const text = stringify(value);
			return text === undefined ? String(value) : text;
		} catch {
			return String(value);
		}
	};
	const log = (...args) => {
		if (logLines.length >= LIMITS.logLines) return;
		let line = "";
		for (let index = 0; index < args.length; index++) line += (index ? " " : "") + show(args[index]);
		logLines.push(line.length > LIMITS.logLineChars ? `${line.slice(0, LIMITS.logLineChars)}…` : line);
	};
	globalThis.console = freeze({ log, info: log, warn: log, error: log, debug: log });

	// Nodes are opaque, frozen {type} objects; their content lives here, so only ui.* can create them.
	const records = new WeakMapRef();
	const spans = new WeakMapRef();
	let phase = "idle";

	const isPlain = (value) =>
		value !== null &&
		typeof value === "object" &&
		(getPrototypeOf(value) === ObjectPrototype || getPrototypeOf(value) === null);
	const describe = (value) =>
		value === null ? "null" : isArray(value) ? "an array" : typeof value === "object" ? "an object" : typeof value;

	/** Check a props object against the names a node accepts. */
	function props(name, value, allowed, required = false) {
		if (value === undefined && !required) return {};
		if (!isPlain(value)) fail(`${name} expects a props object, got ${describe(value)}`);
		const names = keys(value);
		for (let index = 0; index < names.length; index++)
			if (!allowed.includes(names[index]))
				fail(`${name}: unknown prop "${names[index]}" (allowed: ${allowed.join(", ")})`);
		return value;
	}
	function str(name, prop, value, optional) {
		if (value === undefined && optional) return undefined;
		if (typeof value === "number" && finite(value)) return String(value);
		if (typeof value !== "string") fail(`${name}: ${prop} must be a string, got ${describe(value)}`);
		return value;
	}
	function num(name, prop, value, optional, min, max) {
		if (value === undefined && optional) return undefined;
		if (typeof value !== "number" || !finite(value))
			fail(`${name}: ${prop} must be a finite number, got ${show(value)}`);
		if ((min !== undefined && value < min) || (max !== undefined && value > max))
			fail(`${name}: ${prop} must be between ${min} and ${max}, got ${value}`);
		return value;
	}
	function bool(name, prop, value) {
		if (value === undefined) return undefined;
		if (typeof value !== "boolean") fail(`${name}: ${prop} must be true or false, got ${show(value)}`);
		return value;
	}
	function pick(name, prop, value, list, what) {
		if (value === undefined) return undefined;
		if (!list.includes(value))
			fail(`${name}: ${prop} ${stringify(value) ?? String(value)} is not ${what ?? "one of"} ${list.join(", ")}`);
		return value;
	}
	const color = (name, prop, value) => pick(name, prop, value, COLORS, "a color token:");
	function key(name, value) {
		if (value === undefined) return undefined;
		if (typeof value === "number" && finite(value)) return String(value);
		if (typeof value !== "string" || !value || value.length > 200)
			fail(`${name}: key must be a non-empty string or a number`);
		return value;
	}
	function handler(name, prop, value) {
		if (typeof value !== "function") fail(`${name}: ${prop} must be a function, got ${describe(value)}`);
		return value;
	}
	/** Copy only the props that were set, so trees stay small. */
	function compact(out) {
		const result = {};
		const names = keys(out);
		for (let index = 0; index < names.length; index++)
			if (out[names[index]] !== undefined) result[names[index]] = out[names[index]];
		return result;
	}

	function node(out, text, children, control) {
		const value = freeze({ type: out.type });
		records.set(value, { out: compact(out), text, children, control });
		return value;
	}

	/** Flatten nested arrays; skip null, undefined and booleans (for cond && node); strings become text. */
	function children(name, list) {
		if (!isArray(list)) fail(`${name} expects an array of children, got ${describe(list)}`);
		const result = [];
		const seen = new Set();
		const add = (item, depth) => {
			if (item === null || item === undefined || typeof item === "boolean") return;
			if (isArray(item)) {
				if (depth > 8) fail(`${name}: children are nested too deeply`);
				for (let index = 0; index < item.length; index++) add(item[index], depth + 1);
				return;
			}
			if (typeof item === "string" || typeof item === "number") item = text(item);
			const record = records.get(item);
			if (!record) fail(`${name}: child ${result.length} is ${describe(item)}, not a ui node`);
			const id = record.out.key;
			if (id !== undefined) {
				if (seen.has(id)) fail(`${name}: duplicate key "${id}" among children`);
				seen.add(id);
			}
			result.push(item);
		};
		add(list, 0);
		return result;
	}
	/** column(children), column(props, children). */
	function container(name, args, allowed, required = false) {
		if (args.length === 1 && isArray(args[0])) {
			if (required) fail(`${name} expects props and children, for example ${name}({ columns: 2 }, [...])`);
			return [{}, children(name, args[0])];
		}
		if (args.length !== 2) fail(`${name} expects (props, children) or (children)`);
		return [props(name, args[0], allowed, true), children(name, args[1])];
	}

	function runs(name, content) {
		const list = isArray(content) ? content : [content];
		const result = [];
		let length = 0;
		for (let index = 0; index < list.length; index++) {
			const item = list[index];
			if (item === null || item === undefined || item === false) continue;
			if (typeof item === "string" || (typeof item === "number" && finite(item))) {
				result.push({ text: String(item) });
				length += String(item).length;
				continue;
			}
			const span = spans.get(item);
			if (!span) fail(`${name}: content must be strings, numbers or ui.span(), got ${describe(item)}`);
			result.push(span);
			length += span.text.length;
		}
		return [result, length];
	}

	function text(content, options) {
		const p = props("text", options, ["key", "size", "weight", "color", "mono", "italic", "align", "lines"]);
		const [list, length] = runs("text", content);
		const lines = num("text", "lines", p.lines, true, 1, 50);
		if (lines !== undefined && !isInteger(lines)) fail("text: lines must be an integer");
		return node(
			{
				type: "text",
				key: key("text", p.key),
				runs: list,
				size: pick("text", "size", p.size, SIZES, "a text size:"),
				weight: pick("text", "weight", p.weight, WEIGHTS, "a weight:"),
				color: color("text", "color", p.color),
				mono: bool("text", "mono", p.mono),
				italic: bool("text", "italic", p.italic),
				align: pick("text", "align", p.align, ALIGN),
				lines,
			},
			length,
		);
	}

	function span(content, options) {
		const p = props("span", options, ["weight", "color", "mono", "italic", "strike"]);
		const value = freeze({ type: "span" });
		spans.set(
			value,
			compact({
				text: str("span", "text", content),
				weight: pick("span", "weight", p.weight, WEIGHTS, "a weight:"),
				color: color("span", "color", p.color),
				mono: bool("span", "mono", p.mono),
				italic: bool("span", "italic", p.italic),
				strike: bool("span", "strike", p.strike),
			}),
		);
		return value;
	}

	function stat(options) {
		const p = props("stat", options, ["key", "label", "value", "unit", "delta", "tone", "caption"], true);
		const out = {
			type: "stat",
			key: key("stat", p.key),
			label: str("stat", "label", p.label),
			value: str("stat", "value", p.value),
			unit: str("stat", "unit", p.unit, true),
			delta: str("stat", "delta", p.delta, true),
			tone: pick("stat", "tone", p.tone, TONES),
			caption: str("stat", "caption", p.caption, true),
		};
		return node(out, textLength(out.label, out.value, out.unit, out.delta, out.caption));
	}

	function textLength(...values) {
		let length = 0;
		for (let index = 0; index < values.length; index++)
			if (typeof values[index] === "string") length += values[index].length;
		return length;
	}

	function table(options) {
		const p = props("table", options, ["key", "columns", "rows"], true);
		if (!isArray(p.columns) || p.columns.length < 1 || p.columns.length > 24)
			fail("table: columns must be an array of 1 to 24 labels or { label, align }");
		let length = 0;
		const columns = [];
		for (let index = 0; index < p.columns.length; index++) {
			const column = p.columns[index];
			const value =
				typeof column === "string"
					? { label: column }
					: (() => {
							const c = props(`table column ${index}`, column, ["label", "align"], true);
							return compact({
								label: str("table", "column label", c.label),
								align: pick("table", "column align", c.align, ALIGN),
							});
						})();
			length += value.label.length;
			columns.push(value);
		}
		if (!isArray(p.rows)) fail("table: rows must be an array of arrays");
		if (p.rows.length > 500) fail(`table: at most 500 rows, got ${p.rows.length}`);
		const rows = [];
		for (let index = 0; index < p.rows.length; index++) {
			const row = p.rows[index];
			if (!isArray(row)) fail(`table: row ${index} must be an array of cells, got ${describe(row)}`);
			if (row.length !== columns.length)
				fail(
					`table: row ${index} has ${row.length} cells for ${columns.length} columns`.replace(
						/\b1 cells/,
						"1 cell",
					),
				);
			const cells = [];
			for (let cell = 0; cell < row.length; cell++) {
				const value = row[cell];
				if (value === null || value === undefined) cells.push(null);
				else if (typeof value === "string") {
					cells.push(value);
					length += value.length;
				} else if (typeof value === "number" && finite(value)) cells.push(value);
				else if (typeof value === "boolean") {
					cells.push(String(value));
					length += 5;
				} else fail(`table: row ${index} cell ${cell} must be a string, number or null, got ${show(value)}`);
			}
			rows.push(cells);
		}
		return node({ type: "table", key: key("table", p.key), columns, rows }, length);
	}

	function chart(options) {
		const p = props(
			"chart",
			options,
			["key", "type", "x", "series", "height", "unit", "stacked", "yMin", "yMax", "xLabel", "yLabel"],
			true,
		);
		const kind = p.type;
		if (!CHARTS.includes(kind)) fail(`chart: type must be one of ${CHARTS.join(", ")}, got ${show(kind)}`);
		if (!isArray(p.x)) fail("chart: x must be an array of labels or numbers");
		if (p.x.length > 2000) fail(`chart: at most 2000 x values, got ${p.x.length}`);
		let length = 0;
		const x = [];
		for (let index = 0; index < p.x.length; index++) {
			const value = p.x[index];
			if (typeof value === "number" && finite(value)) x.push(value);
			else if (typeof value === "string" && kind !== "scatter") {
				x.push(value);
				length += value.length;
			} else
				fail(
					"chart: x[" +
						index +
						"] must be " +
						(kind === "scatter" ? "a number" : "a string or number") +
						", got " +
						show(value),
				);
		}
		if (!isArray(p.series) || p.series.length < 1 || p.series.length > 12)
			fail("chart: series must be an array of 1 to 12 { name, values }");
		const series = [];
		const names = new Set();
		for (let index = 0; index < p.series.length; index++) {
			const s = props(`chart series ${index}`, p.series[index], ["name", "values", "color"], true);
			const name = str("chart", "series name", s.name);
			if (names.has(name)) fail(`chart: duplicate series name "${name}"`);
			names.add(name);
			if (!isArray(s.values)) fail(`chart series "${name}" values must be an array of numbers`);
			if (s.values.length !== x.length)
				fail(
					`chart series "${name}" has ${s.values.length} values for ${x.length} labels`
						.replace(/\b1 values/, "1 value")
						.replace(/\b1 labels/, "1 label"),
				);
			const values = [];
			for (let point = 0; point < s.values.length; point++) {
				const value = s.values[point];
				if (value === null || value === undefined) values.push(null);
				else if (typeof value === "number" && finite(value)) values.push(value);
				else fail(`chart series "${name}" value ${point} must be a finite number or null, got ${show(value)}`);
			}
			length += name.length;
			series.push(compact({ name, values, color: color("chart", "series color", s.color) }));
		}
		const out = {
			type: "chart",
			key: key("chart", p.key),
			kind,
			x,
			series,
			height: num("chart", "height", p.height ?? 220, false, 80, 480),
			unit: str("chart", "unit", p.unit, true),
			stacked: bool("chart", "stacked", p.stacked),
			yMin: num("chart", "yMin", p.yMin, true),
			yMax: num("chart", "yMax", p.yMax, true),
			xLabel: str("chart", "xLabel", p.xLabel, true),
			yLabel: str("chart", "yLabel", p.yLabel, true),
		};
		if (out.stacked && kind !== "bar" && kind !== "area") fail("chart: stacked applies to bar and area charts only");
		if (out.yMin !== undefined && out.yMax !== undefined && out.yMin >= out.yMax)
			fail("chart: yMin must be less than yMax");
		return node(out, length + textLength(out.unit, out.xLabel, out.yLabel));
	}

	function link(label, options) {
		const p = props("link", options, ["key", "href"], true);
		const href = str("link", "href", p.href);
		if (!/^https?:\/\//i.test(href) || href.length > 2048) fail("link: href must be an http or https URL");
		const out = { type: "link", key: key("link", p.key), label: str("link", "label", label), href };
		return node(out, out.label.length);
	}

	function tabs(options) {
		const p = props("tabs", options, ["key", "options", "value", "onChange"], true);
		if (!isArray(p.options) || p.options.length < 1 || p.options.length > 12)
			fail("tabs: options must be an array of 1 to 12 strings or { value, label }");
		const list = [];
		let length = 0;
		for (let index = 0; index < p.options.length; index++) {
			const option = p.options[index];
			let value;
			if (typeof option === "string" || typeof option === "number")
				value = { value: String(option), label: String(option) };
			else {
				const o = props(`tabs option ${index}`, option, ["value", "label"], true);
				const v = str("tabs", "option value", o.value);
				value = { value: v, label: str("tabs", "option label", o.label, true) ?? v };
			}
			if (list.some((item) => item.value === value.value)) fail(`tabs: duplicate option "${value.value}"`);
			length += value.label.length;
			list.push(value);
		}
		const current = str("tabs", "value", p.value);
		if (!list.some((item) => item.value === current)) fail(`tabs: value "${current}" is not one of the options`);
		return node({ type: "tabs", key: key("tabs", p.key), options: list, value: current }, length, undefined, {
			handler: handler("tabs", "onChange", p.onChange),
		});
	}

	function toggle(options) {
		const p = props("toggle", options, ["key", "label", "value", "onChange"], true);
		if (typeof p.value !== "boolean") fail(`toggle: value must be true or false, got ${show(p.value)}`);
		const out = { type: "toggle", key: key("toggle", p.key), label: str("toggle", "label", p.label), value: p.value };
		return node(out, out.label.length, undefined, { handler: handler("toggle", "onChange", p.onChange) });
	}

	function slider(options) {
		const p = props("slider", options, ["key", "label", "min", "max", "step", "value", "unit", "onChange"], true);
		const min = num("slider", "min", p.min);
		const max = num("slider", "max", p.max);
		if (min >= max) fail("slider: min must be less than max");
		const step = num("slider", "step", p.step, true);
		if (step !== undefined && step <= 0) fail("slider: step must be greater than 0");
		const value = num("slider", "value", p.value);
		if (value < min || value > max) fail(`slider: value ${value} is outside ${min}...${max}`);
		const out = {
			type: "slider",
			key: key("slider", p.key),
			label: str("slider", "label", p.label, true),
			min,
			max,
			step,
			value,
			unit: str("slider", "unit", p.unit, true),
		};
		return node(out, textLength(out.label, out.unit), undefined, {
			handler: handler("slider", "onChange", p.onChange),
		});
	}

	function button(options) {
		const p = props("button", options, ["key", "label", "onClick", "primary", "disabled"], true);
		const out = {
			type: "button",
			key: key("button", p.key),
			label: str("button", "label", p.label),
			primary: bool("button", "primary", p.primary),
			disabled: bool("button", "disabled", p.disabled),
		};
		return node(out, out.label.length, undefined, { handler: handler("button", "onClick", p.onClick) });
	}

	function canvas(options) {
		const p = props("canvas", options, ["key", "height", "animated", "label", "draw"], true);
		const out = {
			type: "canvas",
			key: key("canvas", p.key),
			height: num("canvas", "height", p.height ?? 240, false, 24, 600),
			animated: bool("canvas", "animated", p.animated),
			label: str("canvas", "label", p.label, true),
		};
		return node(out, textLength(out.label), undefined, { draw: handler("canvas", "draw", p.draw) });
	}

	/*
	 * DRAW_FORMAT: a draw records commands into one Float64Array, each a run of numbers starting with its op:
	 *   SAVE 1 | RESTORE 2 | TRANSLATE 3 x y | ROTATE 4 radians | SCALE 5 x y | OPACITY 6 factor
	 *   Shapes: op, mode (1 fill, 2 stroke), color (index in COLORS), opacity, line width (0 when filling), then
	 *   RECT 10 x y w h radius | CIRCLE 11 cx cy r | LINE 12 x1 y1 x2 y2 | PATH 13 closed n x1 y1 ... xn yn |
	 *   ARC 14 cx cy r inner start end (fill: a wedge, or a ring segment when inner > 0; stroke: the arc at r)
	 *   TEXT 20 color opacity x y string size weight align baseline mono, where string indexes frame().strings,
	 *   size indexes SIZES, align ALIGN and baseline BASELINES, and mono is 0 or 1.
	 * A shape with both fill and stroke records twice, fill first. Every record counts as one command.
	 */
	const BASELINES = ["top", "middle", "bottom"];
	const lookup = (list) => {
		const map = Object.create(null);
		for (let index = 0; index < list.length; index++) map[list[index]] = index;
		return map;
	};
	const COLOR_INDEX = lookup(COLORS);
	const SIZE_INDEX = lookup(SIZES);
	const ALIGN_INDEX = lookup(ALIGN);
	const BASELINE_INDEX = lookup(BASELINES);
	const WEIGHT_INDEX = lookup(WEIGHTS);

	let canvases = new Map();
	let ops = new Float64ArrayRef(4096);
	let used = 0;
	let strings = [];
	let commands = 0;
	let points = 0;
	let textChars = 0;
	let depth = 0;
	let drawing = false;
	// The current call's style, parsed without allocating.
	let fillColor = -1;
	let strokeColor = -1;
	let alpha = 1;
	let lineWidth = 1;
	let extraValue;

	function room(count) {
		if (used + count <= ops.length) return;
		let size = ops.length * 2;
		while (size < used + count) size *= 2;
		const next = new Float64ArrayRef(size);
		next.set(ops.subarray(0, used));
		ops = next;
	}
	function begin(name) {
		if (!drawing) fail(`g.${name} can only be called while its canvas draws`);
		if (++commands > LIMITS.drawCommands) fail(`the drawing has more than ${LIMITS.drawCommands} commands`);
	}
	function coord(name, prop, value) {
		if (typeof value !== "number" || !finite(value))
			fail(`g.${name}: ${prop} must be a finite number, got ${show(value)}`);
		return value;
	}
	function token(name, prop, value) {
		if (value === undefined) return -1;
		const index = typeof value === "string" ? COLOR_INDEX[value] : undefined;
		if (index === undefined)
			fail(`g.${name}: ${prop} ${stringify(value) ?? String(value)} is not a color token: ${COLORS.join(", ")}`);
		return index;
	}
	function fraction(name, prop, value, max) {
		if (value === undefined) return undefined;
		coord(name, prop, value);
		if (value < 0 || value > max) fail(`g.${name}: ${prop} must be between 0 and ${max}, got ${value}`);
		return value;
	}
	/** Parse a shape's style: fill, stroke, width, opacity and one extra prop for some shapes. */
	function style(name, value, extra) {
		fillColor = -1;
		strokeColor = -1;
		alpha = 1;
		lineWidth = 1;
		extraValue = undefined;
		if (value === undefined) return;
		if (!isPlain(value)) fail(`g.${name} expects a style object, got ${describe(value)}`);
		const names = keys(value);
		for (let index = 0; index < names.length; index++) {
			const prop = names[index];
			const item = value[prop];
			if (prop === "fill") fillColor = token(name, prop, item);
			else if (prop === "stroke") strokeColor = token(name, prop, item);
			else if (prop === "opacity") alpha = fraction(name, prop, item, 1) ?? 1;
			else if (prop === "width") lineWidth = fraction(name, prop, item, 100) ?? 1;
			else if (prop === extra) extraValue = item;
			else
				fail(
					`g.${name}: unknown style "${prop}" (allowed: fill, stroke, width, opacity${extra ? `, ${extra}` : ""})`,
				);
		}
	}
	function paint(name) {
		if (fillColor < 0 && strokeColor < 0) fail(`g.${name} needs fill or stroke, for example { fill: "chart1" }`);
	}
	function head(name, op, mode, size) {
		begin(name);
		room(5 + size);
		ops[used++] = op;
		ops[used++] = mode;
		ops[used++] = mode === 1 ? fillColor : strokeColor;
		ops[used++] = alpha;
		ops[used++] = mode === 1 ? 0 : lineWidth;
	}
	function shape(name, op, a, b, c, d, e, f, size) {
		paint(name);
		for (let mode = 1; mode <= 2; mode++) {
			if ((mode === 1 ? fillColor : strokeColor) < 0) continue;
			head(name, op, mode, size);
			ops[used++] = a;
			ops[used++] = b;
			ops[used++] = c;
			if (size > 3) ops[used++] = d;
			if (size > 4) ops[used++] = e;
			if (size > 5) ops[used++] = f;
		}
	}
	function transform(name, op, a, b, size) {
		begin(name);
		room(1 + size);
		ops[used++] = op;
		if (size > 0) ops[used++] = a;
		if (size > 1) ops[used++] = b;
	}

	const pen = freeze({
		rect(x, y, w, h, options) {
			style("rect", options, "radius");
			const radius = fraction("rect", "radius", extraValue, 10000) ?? 0;
			shape(
				"rect",
				10,
				coord("rect", "x", x),
				coord("rect", "y", y),
				coord("rect", "w", w),
				coord("rect", "h", h),
				radius,
				0,
				5,
			);
		},
		circle(cx, cy, r, options) {
			style("circle", options);
			const radius = coord("circle", "r", r);
			if (radius < 0) fail(`g.circle: r must not be negative, got ${radius}`);
			shape("circle", 11, coord("circle", "cx", cx), coord("circle", "cy", cy), radius, 0, 0, 0, 3);
		},
		line(x1, y1, x2, y2, options) {
			style("line", options);
			if (fillColor >= 0) fail("g.line draws with stroke only, not fill");
			if (strokeColor < 0) fail('g.line needs stroke, for example { stroke: "muted" }');
			shape(
				"line",
				12,
				coord("line", "x1", x1),
				coord("line", "y1", y1),
				coord("line", "x2", x2),
				coord("line", "y2", y2),
				0,
				0,
				4,
			);
		},
		path(list, options) {
			style("path", options, "close");
			const closed = bool("g.path", "close", extraValue) ? 1 : 0;
			if (!isArray(list)) fail(`g.path expects an array of points, got ${describe(list)}`);
			const pairs = list.length > 0 && isArray(list[0]);
			const count = pairs ? list.length : list.length / 2;
			if (!pairs && !isInteger(count)) fail("g.path: a flat point list needs an even number of values");
			if (count < 2) fail("g.path needs at least 2 points");
			points += count;
			if (points > LIMITS.drawPoints) fail(`the drawing has more than ${LIMITS.drawPoints} path points`);
			for (let index = 0; index < list.length; index++) {
				const item = list[index];
				if (pairs) {
					if (!isArray(item) || item.length !== 2) fail(`g.path: point ${index} must be [x, y]`);
					coord("path", `point ${index} x`, item[0]);
					coord("path", `point ${index} y`, item[1]);
				} else coord("path", `value ${index}`, item);
			}
			paint("path");
			for (let mode = 1; mode <= 2; mode++) {
				if ((mode === 1 ? fillColor : strokeColor) < 0) continue;
				head("path", 13, mode, 2 + count * 2);
				ops[used++] = closed;
				ops[used++] = count;
				if (pairs)
					for (let index = 0; index < count; index++) {
						ops[used++] = list[index][0];
						ops[used++] = list[index][1];
					}
				else for (let index = 0; index < list.length; index++) ops[used++] = list[index];
			}
		},
		arc(cx, cy, r, start, end, options) {
			style("arc", options, "inner");
			const radius = coord("arc", "r", r);
			if (radius < 0) fail(`g.arc: r must not be negative, got ${radius}`);
			const inner = fraction("arc", "inner", extraValue, radius) ?? 0;
			paint("arc");
			for (let mode = 1; mode <= 2; mode++) {
				if ((mode === 1 ? fillColor : strokeColor) < 0) continue;
				head("arc", 14, mode, 6);
				ops[used++] = coord("arc", "cx", cx);
				ops[used++] = coord("arc", "cy", cy);
				ops[used++] = radius;
				ops[used++] = inner;
				ops[used++] = coord("arc", "start", start);
				ops[used++] = coord("arc", "end", end);
			}
		},
		text(x, y, content, options) {
			let value = content;
			if (typeof value === "number" && finite(value)) value = String(value);
			if (typeof value !== "string") fail(`g.text: text must be a string or number, got ${describe(content)}`);
			let colorIndex = 0;
			let opacity = 1;
			let size = 1;
			let weight = 400;
			let align = 0;
			let baseline = 1;
			let mono = 0;
			if (options !== undefined) {
				if (!isPlain(options)) fail(`g.text expects a style object, got ${describe(options)}`);
				const names = keys(options);
				for (let index = 0; index < names.length; index++) {
					const prop = names[index];
					const item = options[prop];
					if (item === undefined) continue;
					if (prop === "color") colorIndex = token("text", prop, item);
					else if (prop === "opacity") opacity = fraction("text", prop, item, 1);
					else if (prop === "size") {
						size = SIZE_INDEX[item];
						if (typeof item !== "string" || size === undefined)
							fail(`g.text: size ${show(item)} is not a text size: ${SIZES.join(", ")}`);
					} else if (prop === "weight") {
						if (WEIGHT_INDEX[item] === undefined || typeof item !== "number")
							fail(`g.text: weight ${show(item)} is not a weight: ${WEIGHTS.join(", ")}`);
						weight = item;
					} else if (prop === "align") {
						align = ALIGN_INDEX[item];
						if (typeof item !== "string" || align === undefined)
							fail(`g.text: align ${show(item)} is not one of ${ALIGN.join(", ")}`);
					} else if (prop === "baseline") {
						baseline = BASELINE_INDEX[item];
						if (typeof item !== "string" || baseline === undefined)
							fail(`g.text: baseline ${show(item)} is not one of ${BASELINES.join(", ")}`);
					} else if (prop === "mono") mono = bool("g.text", "mono", item) ? 1 : 0;
					else
						fail(
							`g.text: unknown style "${prop}" (allowed: color, opacity, size, weight, align, baseline, mono)`,
						);
				}
			}
			begin("text");
			textChars += value.length;
			if (textChars > LIMITS.drawTextChars)
				fail(`the drawing has more than ${LIMITS.drawTextChars} characters of text`);
			room(11);
			ops[used++] = 20;
			ops[used++] = colorIndex;
			ops[used++] = opacity;
			ops[used++] = coord("text", "x", x);
			ops[used++] = coord("text", "y", y);
			ops[used++] = strings.length;
			ops[used++] = size;
			ops[used++] = weight;
			ops[used++] = align;
			ops[used++] = baseline;
			ops[used++] = mono;
			strings.push(value);
		},
		save() {
			if (depth >= 64) fail("g.save is nested more than 64 deep");
			transform("save", 1, 0, 0, 0);
			depth++;
		},
		restore() {
			if (drawing && depth === 0) fail("g.restore has no matching g.save");
			transform("restore", 2, 0, 0, 0);
			depth--;
		},
		translate(x, y) {
			transform("translate", 3, coord("translate", "x", x), coord("translate", "y", y), 2);
		},
		rotate(radians) {
			transform("rotate", 4, coord("rotate", "radians", radians), 0, 1);
		},
		scale(x, y) {
			const sx = coord("scale", "x", x);
			transform("scale", 5, sx, y === undefined ? sx : coord("scale", "y", y), 2);
		},
		opacity(factor) {
			transform("opacity", 6, fraction("opacity", "factor", factor, 1) ?? coord("opacity", "factor", factor), 0, 1);
		},
	});

	// Names the shader prelude declares, and GLSL's own prefixes, which inputs can't take.
	const SHADER_RESERVED = /^(?:iResolution|iTime|iTimeDelta|iFrame|iMouse|main|mainImage|pilot.*|gl_.*)$/;

	function shader(options) {
		const p = props("shader", options, ["key", "height", "animated", "label", "glsl", "inputs"], true);
		const glsl = str("shader", "glsl", p.glsl);
		if (!glsl.includes("mainImage"))
			fail("shader: glsl must define void mainImage(out vec4 fragColor, in vec2 fragCoord)");
		if (glsl.length > LIMITS.shaderChars) fail(`shader: glsl is longer than ${LIMITS.shaderChars} characters`);
		let inputs;
		if (p.inputs !== undefined) {
			if (!isPlain(p.inputs)) fail(`shader: inputs must be an object of numbers, got ${describe(p.inputs)}`);
			const names = keys(p.inputs).sort();
			if (names.length > LIMITS.shaderInputs) fail(`shader: at most ${LIMITS.shaderInputs} inputs`);
			inputs = {};
			for (let index = 0; index < names.length; index++) {
				const name = names[index];
				if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) || SHADER_RESERVED.test(name) || name.includes("__"))
					fail(`shader: input "${name}" is not a usable GLSL name`);
				inputs[name] = num("shader", `input "${name}"`, p.inputs[name]);
			}
			if (!names.length) inputs = undefined;
		}
		const out = {
			type: "shader",
			key: key("shader", p.key),
			height: num("shader", "height", p.height ?? 240, false, 24, 600),
			animated: bool("shader", "animated", p.animated),
			label: str("shader", "label", p.label, true),
			glsl,
			inputs,
		};
		return node(out, textLength(out.label));
	}

	const ui = freeze({
		column: (...args) => {
			const [p, list] = container("column", args, ["key", "gap", "align"]);
			return node(
				{
					type: "column",
					key: key("column", p.key),
					gap: num("column", "gap", p.gap, true, 0, 64),
					align: pick("column", "align", p.align, ALIGN),
				},
				0,
				list,
			);
		},
		row: (...args) => {
			const [p, list] = container("row", args, ["key", "gap", "align", "justify"]);
			return node(
				{
					type: "row",
					key: key("row", p.key),
					gap: num("row", "gap", p.gap, true, 0, 64),
					align: pick("row", "align", p.align, ["start", "center", "end", "baseline"]),
					justify: pick("row", "justify", p.justify, ["start", "center", "end", "between"]),
				},
				0,
				list,
			);
		},
		grid: (...args) => {
			const [p, list] = container("grid", args, ["key", "columns", "gap"], true);
			const columns = num("grid", "columns", p.columns, false, 1, 12);
			if (!isInteger(columns)) fail("grid: columns must be an integer");
			return node(
				{ type: "grid", key: key("grid", p.key), columns, gap: num("grid", "gap", p.gap, true, 0, 64) },
				0,
				list,
			);
		},
		text,
		span,
		stat,
		table,
		chart,
		rule: (options) => node({ type: "rule", key: key("rule", props("rule", options, ["key"]).key) }, 0),
		space: (options) => {
			const p = typeof options === "number" ? { size: options } : props("space", options, ["key", "size"]);
			return node({ type: "space", key: key("space", p.key), size: num("space", "size", p.size, true, 0, 96) }, 0);
		},
		link,
		tabs,
		toggle,
		slider,
		button,
		canvas,
		shader,
	});

	// Reader state: plain JSON slots, one per state() call in setup, restored by call order.
	let slots = [];
	let saved = [];
	let changed = [];

	function json(value, path, depth) {
		if (value === null || typeof value === "string" || typeof value === "boolean") return;
		if (typeof value === "number") {
			if (!finite(value)) fail(`state.${path} must be JSON: ${value} is not finite`);
			return;
		}
		if (depth > 32) fail(`state.${path} is nested too deeply`);
		if (isArray(value)) {
			for (let index = 0; index < value.length; index++) json(value[index], `${path}[${index}]`, depth + 1);
			return;
		}
		if (!isPlain(value)) fail(`state.${path} must be JSON, got ${describe(value)}`);
		const names = keys(value);
		for (let index = 0; index < names.length; index++)
			json(value[names[index]], `${path}.${names[index]}`, depth + 1);
	}
	const sameShape = (a, b) =>
		a === null || b === null ? a === b : isArray(a) ? isArray(b) : typeof a === typeof b && isArray(a) === isArray(b);

	function state(initial) {
		if (phase !== "setup")
			fail("state() can only be called while the visual function sets up, before it returns the view");
		if (!isPlain(initial)) fail('state() takes an object of initial values, for example state({ tab: "p95" })');
		const names = keys(initial);
		for (let index = 0; index < names.length; index++) json(initial[names[index]], names[index], 0);
		const target = parse(stringify(initial));
		const restore = saved[slots.length];
		if (isPlain(restore))
			for (let index = 0; index < names.length; index++) {
				const name = names[index];
				if (hasOwn(restore, name) && sameShape(restore[name], target[name])) target[name] = restore[name];
			}
		slots.push(target);
		const write = (name) => {
			if (typeof name !== "string") fail("state keys must be strings");
			if (phase === "view") fail(`state can only change in handlers, not while the view renders (state.${name})`);
			if (phase === "draw") fail(`state can only change in handlers, not while a canvas draws (state.${name})`);
			if (phase === "handler" && !changed.includes(name)) changed.push(name);
		};
		return new RealProxy(target, {
			set(object, name, value) {
				write(name);
				json(value, name, 0);
				object[name] = value;
				return true;
			},
			deleteProperty(object, name) {
				write(name);
				delete object[name];
				return true;
			},
			defineProperty() {
				return fail("state properties can only be assigned");
			},
		});
	}

	function deepFreeze(value) {
		if (value !== null && typeof value === "object") {
			freeze(value);
			const names = keys(value);
			for (let index = 0; index < names.length; index++) deepFreeze(value[names[index]]);
		}
		return value;
	}

	let view;
	let controls = new Map();

	function load(fn, source, dataJson, stateJson, seedText, nowValue) {
		// FNV-1a over UTF-16 code units.
		const id = String(seedText);
		seed = 0x811c9dc5;
		for (let index = 0; index < id.length; index++) seed = Math.imul(seed ^ id.charCodeAt(index), 0x01000193);
		seed >>>= 0;
		now = nowValue;
		slots = [];
		changed = [];
		controls = new Map();
		canvases = new Map();
		view = undefined;
		saved = [];
		if (typeof stateJson === "string") {
			try {
				const value = parse(stateJson);
				if (isArray(value)) saved = value;
			} catch {
				// A damaged saved state falls back to the initial values.
			}
		}
		if (typeof fn !== "function") fail("source must be a function expression, as String(visual) returns");
		const text = functionToString.call(fn);
		if (text !== String(source).trim())
			fail("source must be exactly one function expression, as String(visual) returns");
		if (/^class\b/.test(text)) fail("source must be a function, not a class");
		const kind = getPrototypeOf(fn)?.constructor?.name;
		if (kind !== "Function") fail("the visual function must be a plain function, not an async function or generator");
		const data = deepFreeze(dataJson === undefined ? null : parse(dataJson));
		phase = "setup";
		let result;
		try {
			result = fn(freeze({ ui, state, data }));
		} finally {
			phase = "idle";
		}
		if (typeof result === "function") view = result;
		else if (result !== null && typeof result === "object" && typeof result.then === "function")
			fail("the visual function must return the view, not a Promise");
		else {
			root(result);
			view = () => result;
		}
	}

	function root(value) {
		if (isArray(value)) return ui.column(value);
		if (typeof value === "string" || typeof value === "number") return text(value);
		if (!records.has(value))
			fail(
				"the view must return a ui node, got " +
					describe(value) +
					" (return () => ui.column([...]) from the visual)",
			);
		return value;
	}

	function render(nowValue) {
		if (!view) fail("load the visual before rendering it");
		now = nowValue;
		phase = "view";
		let result;
		try {
			result = view();
		} finally {
			phase = "idle";
		}
		const top = root(result);
		const count = { nodes: 0, text: 0 };
		const next = new Map();
		const nextCanvases = new Map();
		const walk = (value, path) => {
			if (++count.nodes > LIMITS.nodes) fail(`the view has more than ${LIMITS.nodes} nodes`);
			const record = records.get(value);
			count.text += record.text;
			if (count.text > LIMITS.textChars) fail(`the view has more than ${LIMITS.textChars} characters of text`);
			const out = {};
			const names = keys(record.out);
			for (let index = 0; index < names.length; index++) out[names[index]] = record.out[names[index]];
			if (record.control) {
				out.id = path;
				if (record.control.draw) nextCanvases.set(path, record.control.draw);
				else next.set(path, { out, handler: record.control.handler });
			}
			if (record.children) {
				const list = [];
				for (let index = 0; index < record.children.length; index++)
					list.push(walk(record.children[index], `${path}.${index}`));
				out.children = list;
			}
			return out;
		};
		const tree = { api: API, root: walk(top, "0") };
		controls = next;
		canvases = nextCanvases;
		return stringify(tree);
	}

	function event(id, valueJson, nowValue) {
		const control = controls.get(id);
		if (!control) fail(`no control with id ${id} in the current view`);
		now = nowValue;
		const out = control.out;
		let value = valueJson === undefined ? null : parse(valueJson);
		if (out.type === "tabs") {
			if (!out.options.some((option) => option.value === value)) fail(`tabs: ${show(value)} is not an option`);
		} else if (out.type === "toggle") {
			if (typeof value !== "boolean") fail("toggle: event value must be true or false");
		} else if (out.type === "slider") {
			if (typeof value !== "number" || !finite(value)) fail("slider: event value must be a finite number");
			if (out.step !== undefined) value = out.min + Math.round((value - out.min) / out.step) * out.step;
			value = Math.min(out.max, Math.max(out.min, value));
		} else {
			if (out.disabled) return stringify({ changed: [] });
			value = undefined;
		}
		changed = [];
		phase = "handler";
		let result;
		try {
			result = value === undefined ? control.handler() : control.handler(value);
		} finally {
			phase = "idle";
		}
		if (result !== null && typeof result === "object" && typeof result.then === "function")
			fail(`${out.type}: handlers must be synchronous and only assign to state`);
		stateJson();
		return stringify({ changed });
	}

	function stateJson() {
		const value = stringify(slots);
		if (value.length > LIMITS.stateChars) fail(`state is larger than ${LIMITS.stateChars} characters of JSON`);
		return value;
	}

	function logs() {
		const value = stringify(logLines);
		logLines = [];
		return value;
	}

	function draw(id, width, height, t, pointerX, pointerY) {
		const fn = canvases.get(id);
		if (!fn) fail(`no canvas with id ${id} in the current view`);
		if (!finite(width) || !finite(height) || !finite(t)) fail("draw needs a finite width, height and time");
		used = 0;
		strings = [];
		commands = 0;
		points = 0;
		textChars = 0;
		depth = 0;
		const pointer =
			typeof pointerX === "number" && typeof pointerY === "number" && finite(pointerX) && finite(pointerY)
				? freeze({ x: pointerX, y: pointerY })
				: null;
		phase = "draw";
		drawing = true;
		let result;
		try {
			result = fn(pen, freeze({ width, height, t, pointer }));
		} catch (error) {
			used = 0;
			strings = [];
			commands = 0;
			throw error;
		} finally {
			phase = "idle";
			drawing = false;
		}
		if (result !== null && typeof result === "object" && typeof result.then === "function")
			fail("canvas: draw must be synchronous");
		return commands;
	}

	function frame() {
		return { ops: ops.subarray(0, used), strings };
	}

	function frameJson() {
		return stringify({ ops: arrayFrom(ops.subarray(0, used)), strings });
	}

	return freeze({ api: API, limits: LIMITS, load, render, event, state: stateJson, logs, draw, frame, frameJson });
})();
"""##
}
