/** Closed native Mermaid admission, not the Mermaid language or a renderer.
 * Mirrors apps/desktop/src/native_mermaid.rs; both consume the shared syntax corpus.
 * Runs only in the existing bounded visual-check worker, never a browser/VM binding.
 */
export type MermaidFailureKind = "invalid" | "unsupported" | "limit";
export class MermaidError extends Error {
	readonly kind: MermaidFailureKind;
	constructor(kind: MermaidFailureKind, detail: string) {
		super(
			`${kind === "invalid" ? "Invalid Mermaid" : kind === "unsupported" ? "Unsupported Mermaid" : "Mermaid limit exceeded"}: ${detail}`,
		);
		this.kind = kind;
	}
}
const MAX_SOURCE = 20 * 1024;
const MAX_STATEMENTS = 192;
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
// Rust str::trim uses Unicode White_Space, not ECMAScript's BOM-inclusive trim.
const trim = (s: string) => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const trimStart = (s: string) => s.replace(/^\p{White_Space}+/u, "");
function fail(kind: MermaidFailureKind, detail: string): never {
	throw new MermaidError(kind, detail);
}
function statements(source: string): string[] {
	if (source.length > MAX_SOURCE || Buffer.byteLength(source, "utf8") > MAX_SOURCE)
		fail("limit", "Diagram exceeds the 20 KiB source limit.");
	for (const c of source) {
		const code = c.codePointAt(0)!;
		if (code >= 0xd800 && code <= 0xdfff) fail("invalid", "Source contains unpaired UTF-16 surrogates.");
	}
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(source))
		fail("invalid", "Control characters are not supported.");
	// Do not lex another Mermaid grammar as if its quote/bracket rules were
	// flowchart rules. Unsupported is deliberately not a syntax-validity claim.
	let at = 0;
	while (at < source.length) {
		const end = source.indexOf("\n", at);
		const line = trim(source.slice(at, end < 0 ? source.length : end));
		at = end < 0 ? source.length : end + 1;
		if (!line || line.startsWith("%%")) continue;
		const type = line.split(/[\p{White_Space};]/u, 1)[0];
		if (type !== "graph" && type !== "flowchart")
			fail("unsupported", "Only the native flowchart/graph subset can be validated.");
		break;
	}
	const result: string[] = [];
	let start = 0,
		close = "",
		quoted = false,
		comment = false,
		statementStarted = false,
		comments = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (comment) {
			if (c === "\n") {
				comment = false;
				statementStarted = false;
				start = i + 1;
			}
			continue;
		}
		if (!quoted && !close && c === "%" && !statementStarted && source.startsWith("%%", i)) {
			if (trimStart(source.slice(i + 2)).startsWith("{"))
				fail("unsupported", "Directives are outside the native subset.");
			if (++comments + result.length > MAX_STATEMENTS) fail("limit", "Too many diagram statements.");
			comment = true;
			continue;
		}
		if (!/\p{White_Space}/u.test(c)) statementStarted = true;
		if (c === "\\" && (quoted || close)) fail("unsupported", "Escaped labels are outside the native subset.");
		if (c === '"') quoted = !quoted;
		if (!quoted) {
			if (close) {
				if (c === close) close = "";
			} else {
				close = ({ "[": "]", "(": ")", "{": "}", "|": "|" } as Record<string, string>)[c] ?? "";
				if (c === "\n" || c === ";") {
					const s = trim(source.slice(start, i));
					if (s) {
						if (comments + result.length >= MAX_STATEMENTS) fail("limit", "Too many diagram statements.");
						result.push(s);
					}
					start = i + 1;
					statementStarted = false;
				}
			}
		}
	}
	if (comment) start = source.length;
	if (close || quoted) fail("invalid", "Unclosed diagram label.");
	const last = trim(source.slice(start));
	if (last) {
		if (comments + result.length >= MAX_STATEMENTS) fail("limit", "Too many diagram statements.");
		result.push(last);
	}
	return result;
}
function label(raw: string, max: number): string {
	const s = trim(raw);
	const text = s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
	if (Buffer.byteLength(text, "utf8") > 512) fail("limit", "Label exceeds native length limits.");
	let count = 0;
	for (const _ of segmenter.segment(text)) if (++count > max) fail("limit", "Label exceeds native length limits.");
	if (!text || /[\p{Cc}<>&`\\"[\]{}()|\u202a-\u202e\u2066-\u2069]/u.test(text))
		fail("unsupported", "Label exceeds limits or uses unsupported markup/escapes.");
	return text;
}
interface Node {
	id: string;
	label: string;
	shape: string;
	explicit: boolean;
}
interface Edge {
	from: number;
	to: number;
	label: string;
}

/** Throws distinct invalid/unsupported/limit errors. No source-only admission. */
export function validateMermaid(source: string): void {
	const all = statements(source);
	const header = all.shift();
	if (!header) fail("invalid", "Empty Mermaid source.");
	const parts = header.split(/\p{White_Space}+/u).slice(0, 4);
	if (!["flowchart", "graph"].includes(parts[0]))
		fail("unsupported", "Only the native flowchart/graph subset can be validated.");
	if (parts.length !== 2 || !["TD", "TB", "BT", "LR", "RL"].includes(parts[1]))
		fail("invalid", "Expected flowchart/graph followed by TD, TB, BT, LR or RL.");
	const horizontal = parts[1] === "LR" || parts[1] === "RL";
	const nodes: Node[] = [],
		edges: Edge[] = [];
	const ids = new Map<string, number>();
	let rest = "";
	const space = () => {
		rest = trimStart(rest);
	};
	const take = (token: string) => {
		space();
		if (!rest.startsWith(token)) return false;
		rest = rest.slice(token.length);
		return true;
	};
	const endpoint = (): number => {
		space();
		if (!rest) fail("invalid", "Expected a node after the edge.");
		const id = /^[A-Za-z0-9_]+/u.exec(rest)?.[0] ?? "";
		if (id.length > 64) fail("limit", "Node ID exceeds 64 bytes.");
		if (!id) {
			if (/^\p{Alphabetic}/u.test(rest)) fail("unsupported", "Only ASCII node IDs are supported natively.");
			fail("invalid", "Expected a node ID.");
		}
		if (!/^[A-Za-z]/u.test(id)) fail("unsupported", "Node IDs must start with an ASCII letter in the native subset.");
		rest = rest.slice(id.length);
		if (["end", "subgraph", "style", "class", "classDef", "click", "direction", "linkStyle"].includes(id))
			fail("unsupported", "Subgraphs, styling and actions are not supported natively.");
		space();
		const close = ({ "[": "]", "(": ")", "{": "}" } as Record<string, string>)[rest[0]];
		const shape = close ? rest[0] : "[";
		let text = id;
		if (close) {
			rest = rest.slice(1);
			const end = rest.indexOf(close);
			if (end < 0) fail("invalid", "Unclosed node.");
			text = label(rest.slice(0, end), shape === "{" ? 16 : 48);
			rest = rest.slice(end + 1);
		}
		const ix = ids.get(id);
		if (ix !== undefined) {
			if (close) {
				const old = nodes[ix];
				if (old.explicit && (old.label !== text || old.shape !== shape))
					fail("unsupported", "Conflicting node declarations are not supported.");
				old.label = text;
				old.shape = shape;
				old.explicit = true;
			}
			return ix;
		}
		if (nodes.length === 48) fail("limit", "Diagram exceeds 48 nodes.");
		ids.set(id, nodes.length);
		nodes.push({ id, label: text, shape, explicit: !!close });
		return nodes.length - 1;
	};
	for (const statement of all) {
		rest = statement;
		let from = endpoint();
		space();
		while (rest) {
			if (
				["----", "--->", "==", "-.", "<", "~", "&", ":::", "@"].some((t) => rest.startsWith(t)) ||
				(rest.startsWith("--") && !rest.startsWith("-->") && !rest.startsWith("---"))
			)
				fail("unsupported", "This edge/style syntax is outside the native subset.");
			if (!take("-->") && !take("---"))
				fail("invalid", "Expected --> or --- between nodes. No partial diagram is shown.");
			let text = "";
			if (take("|")) {
				const end = rest.indexOf("|");
				if (end < 0) fail("invalid", "Unclosed edge label.");
				text = label(rest.slice(0, end), 24);
				rest = rest.slice(end + 1);
			}
			const to = endpoint();
			if (edges.length === 96) fail("limit", "Diagram exceeds 96 edges.");
			if (from === to || edges.some((e) => e.from === from && e.to === to))
				fail("unsupported", "Self links and parallel edges are not supported natively.");
			edges.push({ from, to, label: text });
			from = to;
			space();
		}
	}
	if (!nodes.length) fail("invalid", "Diagram has no nodes.");
	// Mirror the bounded native layout admission without allocating paths or coordinates.
	const degree = nodes.map(() => 0),
		rank = nodes.map(() => 0);
	for (const edge of edges) degree[edge.to]++;
	const queue = degree.flatMap((d, i) => (d === 0 ? [i] : []));
	for (let at = 0; at < queue.length; at++) {
		const i = queue[at];
		for (const edge of edges)
			if (edge.from === i) {
				rank[edge.to] = Math.max(rank[edge.to], rank[i] + 1);
				if (--degree[edge.to] === 0) queue.push(edge.to);
			}
	}
	if (queue.length !== nodes.length)
		fail("unsupported", "Cycles are not supported by this native layout. Exact source is retained.");
	const depth = Math.max(...rank) + 1;
	if (depth > 24) fail("limit", "Diagram exceeds 24 layout ranks.");
	const slots = nodes.length + edges.reduce((sum, e) => sum + rank[e.to] - rank[e.from] - 1, 0);
	if (slots > 128) fail("limit", "Diagram exceeds 128 layout slots.");
	const breadth = Array<number>(depth).fill(0),
		gaps = Array<number>(depth).fill(0),
		step = Array<number>(depth).fill(horizontal ? 32 : 24);
	for (const r of rank) breadth[r]++;
	for (const e of edges) {
		for (let r = rank[e.from]; r < rank[e.to]; r++) {
			gaps[r]++;
			if (r > rank[e.from]) breadth[r]++;
		}
		if (e.label) step[rank[e.from]] = horizontal ? 208 : 48;
	}
	let primary = 48 + depth * (horizontal ? 240 : 88);
	for (let r = 0; r < depth - 1; r++) primary += 24 + gaps[r] * step[r];
	const across = Math.max(...breadth) * (horizontal ? 120 : 272) + 176;
	if (primary > 8192 || across > 8192 || primary * across > 16_777_216)
		fail("limit", "Diagram exceeds native coordinate/area limits.");
}
