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

	const unsupported = (name) => () => fail(`${name} nodes are not yet supported`);

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
		canvas: unsupported("canvas"),
		shader: unsupported("shader"),
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
				next.set(path, { out, handler: record.control.handler });
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

	return freeze({ api: API, limits: LIMITS, load, render, event, state: stateJson, logs });
})();
"""##
}
