// The screen agent's view of this window, after UI SDK's agent bridge
// (docs/technical/day-screen-agent.md). Every styled control registers
// itself here with live getters of its props and the callbacks a person's
// input calls; the agent reads a snapshot, queries choices and runs steps.
// Nothing here copies page state or writes a signal directly.
import { cleanup, context, type ViewRef, windowSize } from "nsh";

/** What a page marks on a control or a region (`AgentScope`). */
export type AgentMark = {
	/** A sentence saying what the control does. The agent's press fails with "Needs a person". */
	confirm?: string;
	/** Left out of snapshot and query; a step that names it is refused. */
	hidden?: boolean;
	/** The value shows as "[redacted]". */
	secret?: boolean;
};

/** Marks a region: every control inside takes these marks, as UI SDK's data-agent-* attributes do. */
export const AgentScope = context<AgentMark>({});

/** One choice of a list. */
export type AgentItem = { value: string; label: string };

/** What a control tells the registry. Getters read the page's props when called. */
export type AgentControl = {
	component: string;
	label: () => string | null | undefined;
	/** The control's test ID: a stable name a step may use. */
	id?: () => string | null | undefined;
	/** Nearby row text that tells same-named controls apart. */
	row?: () => string | null | undefined;
	/** State keys the agent reads, such as value, checked, open or selected. */
	state?: Record<string, () => unknown>;
	items?: () => AgentItem[];
	/** The value is always one of `items`: other values are refused with the real items. */
	closed?: boolean;
	/** Text the control shows besides its label, such as a notice's words. */
	text?: () => string | null | undefined;
	disabled?: () => boolean | null | undefined;
	/** The control's own marks, besides its region's. */
	mark?: () => AgentMark | null | undefined;
	/** The actions it takes, as UI SDK names them: press, setValue, setChecked, setOpen, toggle, clear, select. */
	actions: Record<string, (...args: unknown[]) => unknown>;
};

type Entry = AgentControl & { ref: string; scope: AgentMark; node: ViewRef | null; order: number };
type Remembered = { ref: string; component: string; label?: string; row?: string; state: Record<string, unknown> };

/** One component as the agent sees it. */
export type AgentComponent = {
	ref: string;
	component: string;
	label?: string;
	id?: string;
	row?: string;
	items?: AgentItem[];
	more?: number;
	text?: string;
	disabled?: true;
	offscreen?: true;
	offPage?: true;
	confirm?: string;
	note?: string;
	use?: string;
	actions: string[];
	[state: string]: unknown;
};

/** One change of a control's state. */
export type AgentChange = {
	ref: string;
	component: string;
	label?: string;
	key: string;
	value: unknown;
	previous?: unknown;
};

export type AgentStep = { ref: string; action: string; args?: unknown[] };
export type ActResult = {
	ok: boolean;
	error?: { step: number; message: string };
	steps: { step: number; ref: string; result?: unknown; changes?: AgentChange[]; gone?: string[] }[];
	appeared?: string[];
	open?: string[];
	values: Record<string, unknown>;
	more?: number;
};

// UI SDK's limits, so an agent prompted for its tools reads the same shapes. 100 entries of a few hundred
// bytes keep one answer well under the route's 256 KiB.
const SNAPSHOT_LIMIT = 100;
const ITEM_LIMIT = 50;
const INLINE_ITEMS = 10;
const REMEMBERED = 50;
const REF_MEMORY = 500;
/** Person changes kept for the next snapshot: a few minutes of work on one screen. */
const CHANGE_LIMIT = 50;
/** How long a step waits for its callback's work, as UI SDK's Button does. */
const PRESS_WAIT_MS = 15_000;
const STATE_KEYS = ["value", "checked", "open", "selected", "pressed"];
const REDACTED = "[redacted]";

const entries = new Map<string, Entry>();
const remembered: Remembered[] = [];
const refMemory: { key: string; ref: string }[] = [];
let nextRef = 1;
let nextOrder = 0;
let header: () => Record<string, unknown> = () => ({});
let shown = new Map<string, Record<string, unknown>>();
const changes: AgentChange[] = [];
let acting = false;
let blocked: string[] = [];

/** A call an agent step tried to send to Pilot. The bridge refused it; the step fails as needing a person. */
export function noteBlockedWrite(name: string) {
	blocked.push(name);
}

/** The screen header the snapshot starts with: place, IDs shown, freshness. The app sets it once. */
export function setScreenHeader(read: () => Record<string, unknown>) {
	header = read;
}

/** Words for matching: lower case, no accents, split on anything that is not a letter or digit. */
export function words(text: string): string[] {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function fold(text: string): string {
	return words(text).join(" ");
}

/** Whether the needle's words appear in order as a run of whole words. */
function hasWords(haystack: string, needle: string): boolean {
	const want = words(needle);
	if (want.length === 0) return false;
	const have = words(haystack);
	for (let i = 0; i + want.length <= have.length; i++) {
		if (want.every((w, j) => have[i + j] === w)) return true;
	}
	return false;
}

function str(v: string | null | undefined): string | undefined {
	return v ? v : undefined;
}

function marks(e: Entry): AgentMark {
	return { ...e.scope, ...(e.mark?.() ?? {}) };
}

function memoryKey(component: string, label?: string, row?: string) {
	return [component, label ?? "", row ?? ""].join("\u0000");
}

/**
 * Registers a control for the life of its owner. Call it in a component body. `anchor` hears the control's view,
 * so the snapshot can order entries by position and say which ones are off screen.
 */
export function useAgent(control: AgentControl): { anchor: (node: ViewRef) => void } {
	const scope = AgentScope();
	const key = memoryKey(control.component, str(control.label()), str(control.row?.()));
	// A returning control keeps its remembered ref while kind, label and row match.
	const reused = refMemory.findIndex((m) => m.key === key && !entries.has(m.ref));
	const ref = reused >= 0 ? refMemory.splice(reused, 1)[0].ref : `c${nextRef++}`;
	const at = remembered.findIndex((r) => r.ref === ref);
	if (at >= 0) remembered.splice(at, 1);
	const entry: Entry = { ...control, ref, scope, node: null, order: nextOrder++ };
	entries.set(ref, entry);
	cleanup(() => {
		entries.delete(ref);
		// A leaving control can outlive the data its getters read (a closed row's item is gone). Then the agent
		// remembers nothing about it.
		try {
			const m = marks(entry);
			const label = str(entry.label());
			const row = str(entry.row?.());
			refMemory.push({ key: memoryKey(entry.component, label, row), ref });
			if (refMemory.length > REF_MEMORY) refMemory.shift();
			if (m.hidden) return;
			// A secret field is not kept after it leaves, as in UI SDK.
			const state = m.secret ? {} : readState(entry);
			remembered.push({ ref, component: entry.component, label, row, state });
			if (remembered.length > REMEMBERED) remembered.shift();
		} catch {
			// Nothing to remember.
		}
	});
	return {
		anchor: (node: ViewRef) => {
			entry.node = node;
		},
	};
}

function readState(e: Entry): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, get] of Object.entries(e.state ?? {})) {
		const v = get();
		if (v !== undefined && v !== null) out[k] = v;
	}
	return out;
}

function exposedState(e: Entry): Record<string, unknown> {
	const state = readState(e);
	if (marks(e).secret && typeof state.value === "string" && state.value !== "") state.value = REDACTED;
	return state;
}

function available(e: Entry): string[] {
	if (e.disabled?.()) return [];
	return Object.keys(e.actions);
}

type Placed = { entry: Entry; y: number; x: number; offscreen: boolean };

async function place(list: Entry[]): Promise<Placed[]> {
	const size = windowSize();
	const placed = await Promise.all(
		list.map(async (entry): Promise<Placed> => {
			const m = entry.node ? await entry.node.measure().catch(() => null) : null;
			if (!m) return { entry, y: Number.MAX_SAFE_INTEGER, x: entry.order, offscreen: false };
			const { x, y } = m.pagePosition;
			const { width, height } = m.bounds.size;
			const offscreen = y + height <= 0 || y >= size.height || x + width <= 0 || x >= size.width;
			return { entry, y, x, offscreen };
		}),
	);
	return placed.sort((a, b) => a.y - b.y || a.x - b.x || a.entry.order - b.entry.order);
}

function describe(p: Placed): AgentComponent {
	const e = p.entry;
	const m = marks(e);
	const out: AgentComponent = { ref: e.ref, component: e.component, actions: available(e) };
	const label = str(e.label());
	if (label) out.label = label;
	const id = str(e.id?.());
	if (id) out.id = id;
	const row = str(e.row?.());
	if (row) out.row = row;
	Object.assign(out, exposedState(e));
	const items = e.items?.() ?? [];
	if (items.length > 0 && items.length <= INLINE_ITEMS) out.items = items;
	else if (items.length > INLINE_ITEMS) out.note = `${items.length} choices: use query with within.`;
	const text = str(e.text?.());
	if (text) out.text = text;
	if (e.disabled?.()) out.disabled = true;
	if (p.offscreen) out.offscreen = true;
	if (m.confirm) out.confirm = m.confirm;
	return out;
}

function visibleEntries(): Entry[] {
	return [...entries.values()].filter((e) => !marks(e).hidden);
}

function offPage(r: Remembered): AgentComponent {
	const out: AgentComponent = { ref: r.ref, component: r.component, ...r.state, offPage: true, actions: [] };
	if (r.label) out.label = r.label;
	if (r.row) out.row = r.row;
	return out;
}

function limited(list: AgentComponent[]): AgentComponent[] {
	if (list.length <= SNAPSHOT_LIMIT) return list;
	const more = list.length - SNAPSHOT_LIMIT;
	return [...list.slice(0, SNAPSHOT_LIMIT), { ref: "more", component: "more", more, use: "query", actions: [] }];
}

/** Notes the state each control showed, so the next snapshot reports what changed since. */
function remember(list: AgentComponent[]) {
	const next = new Map<string, Record<string, unknown>>();
	for (const c of list) {
		const s: Record<string, unknown> = {};
		for (const k of STATE_KEYS) if (k in c) s[k] = c[k];
		next.set(c.ref, s);
	}
	shown = next;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Keeps what the page or the person changed since the agent last read the window. */
function collectChanges() {
	for (const e of visibleEntries()) {
		const before = shown.get(e.ref);
		if (!before) continue;
		const now = exposedState(e);
		for (const k of STATE_KEYS) {
			if (!(k in now) && !(k in before)) continue;
			if (same(now[k], before[k])) continue;
			changes.push({
				ref: e.ref,
				component: e.component,
				label: str(e.label()),
				key: k,
				value: now[k],
				previous: before[k],
			});
			if (changes.length > CHANGE_LIMIT) changes.shift();
		}
	}
}

export type Snapshot = { screen: Record<string, unknown>; components: AgentComponent[]; changes: AgentChange[] };

/** The window as the agent sees it: the screen header, the components in screen order and what changed. */
export async function snapshot(): Promise<Snapshot> {
	collectChanges();
	const placed = await place(visibleEntries());
	const list = [...placed.map(describe), ...remembered.map(offPage)];
	remember(list);
	return { screen: header(), components: limited(list), changes: changes.splice(0) };
}

function matching(items: AgentItem[], text: string): AgentItem[] {
	const want = fold(text);
	return items.filter((i) => fold(`${i.label} ${i.value}`).includes(want));
}

/** Finds components and their choices without listing the page. It never opens anything. */
export async function query(q: {
	text?: string;
	within?: string;
	kind?: string;
}): Promise<AgentComponent[] | { error: string }> {
	if (!q.text && !q.within && !q.kind) return { error: "Pass text, within or kind." };
	const placed = await place(visibleEntries());
	if (q.within) {
		const found = resolve(
			q.within,
			placed.map((p) => p.entry),
		);
		if ("error" in found) return { error: found.error };
		const c = describe(placed.find((x) => x.entry === found.entry) as Placed);
		const all = found.entry.items?.() ?? [];
		const match = q.text ? matching(all, q.text) : all;
		c.items = match.slice(0, ITEM_LIMIT);
		delete c.note;
		if (match.length > ITEM_LIMIT) c.more = match.length - ITEM_LIMIT;
		if (all.length === 0) c.note = "Its choices show only while it is open: setValue takes a choice's label.";
		return [c];
	}
	const out: AgentComponent[] = [];
	for (const p of placed) {
		const e = p.entry;
		if (q.kind && e.component !== q.kind) continue;
		if (!q.text) {
			out.push(describe(p));
			continue;
		}
		const named = hasWords(`${e.label() ?? ""} ${e.row?.() ?? ""}`, q.text);
		const items = matching(e.items?.() ?? [], q.text);
		if (!named && items.length === 0) continue;
		const c = describe(p);
		if (items.length > 0) {
			c.items = items.slice(0, ITEM_LIMIT);
			delete c.note;
			if (items.length > ITEM_LIMIT) c.more = items.length - ITEM_LIMIT;
		}
		out.push(c);
	}
	for (const r of remembered) {
		if (q.kind && r.component !== q.kind) continue;
		if (q.text && !hasWords(`${r.label ?? ""} ${r.row ?? ""}`, q.text)) continue;
		out.push(offPage(r));
	}
	return limited(out);
}

function name(e: Entry): string {
	const label = str(e.label());
	const row = str(e.row?.());
	return [e.ref, label, row ? `(${row})` : undefined].filter(Boolean).join(" ");
}

type Resolved = { entry: Entry } | { error: string };

/** UI SDK's lookup: a ref, then a test ID, label or row words, then an item, then a kind. */
function resolve(target: string, list: Entry[], action?: string): Resolved {
	const byRef = list.find((e) => e.ref === target);
	if (byRef) return { entry: byRef };
	if (remembered.some((r) => r.ref === target)) return { error: `${target} left the page. Read a fresh snapshot.` };
	if (entries.has(target)) return { error: `${target} is hidden from you. Ask the person.` };
	const byId = list.filter((e) => str(e.id?.()) === target);
	if (byId.length === 1) return { entry: byId[0] };
	const candidates: Entry[][] = [
		list.filter((e) => hasWords(`${e.label() ?? ""} ${e.row?.() ?? ""}`, target)),
		list.filter((e) => (e.items?.() ?? []).some((i) => fold(i.label) === fold(target))),
		list.filter((e) => e.component === target),
	];
	for (const found of candidates) {
		if (found.length === 0) continue;
		if (found.length === 1) return { entry: found[0] };
		// When the words fit several, the one that takes the action wins, as in UI SDK. An exact label does not:
		// labels are page text anyone can write.
		if (action) {
			const taking = found.filter((e) => available(e).includes(action));
			if (taking.length === 1) return { entry: taking[0] };
		}
		return {
			error: `"${target}" names ${found.length} components: ${found.map(name).join(", ")}. Use a ref.`,
		};
	}
	return { error: `Nothing on this window is named "${target}". Read a fresh snapshot or use query.` };
}

/** A choice by value (exact) or by label (whole text, ignoring case and accents). */
function choice(e: Entry, arg: unknown): { value: string } | { error: string } {
	const items = e.items?.() ?? [];
	const text = String(arg);
	const byValue = items.find((i) => i.value === text);
	if (byValue) return { value: byValue.value };
	const byLabel = items.filter((i) => fold(i.label) === fold(text));
	if (byLabel.length === 1) return { value: byLabel[0].value };
	if (byLabel.length > 1) return { error: `"${text}" names ${byLabel.length} choices of ${name(e)}. Use a value.` };
	if (e.closed || items.length > 0) {
		return {
			error: `No item "${text}" in ${name(e)}. Its items: ${items.map((i) => i.label).join(", ")}.`,
		};
	}
	return { value: text };
}

function argError(e: Entry, action: string, args: unknown[]): string | null {
	if (action === "setChecked" || action === "setOpen" || action === "setPressed") {
		if (typeof args[0] !== "boolean") return `${action} on ${name(e)} takes true or false.`;
	}
	if (action === "setValue" && args.length === 0) return `setValue on ${name(e)} takes a value.`;
	if (action === "setValue" && !e.items && typeof args[0] !== "string") return `setValue on ${name(e)} takes text.`;
	return null;
}

/** Lets the page's bindings and effects run after a callback. */
function settle(): Promise<void> {
	return new Promise((done) => setTimeout(done, 0));
}

let busy: () => Promise<void> | null = () => null;

/**
 * The bridge reports when its calls in flight settle, so a step waits for the work its control started: a read
 * that is followed by a write still runs inside the step, where the write is refused.
 */
export function setBusyProbe(probe: () => Promise<void> | null) {
	busy = probe;
}

/** Waits until the page's work settles, or until `deadline`. */
async function quiet(deadline: number) {
	for (;;) {
		await settle();
		const pending = busy();
		const left = deadline - Date.now();
		if (!pending || left <= 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([pending, new Promise<void>((done) => (timer = setTimeout(done, left)))]);
		clearTimeout(timer);
	}
}

async function run(e: Entry, action: string, args: unknown[]): Promise<unknown> {
	let callArgs = args;
	if (action === "setValue" && e.items) {
		const c = choice(e, args[0]);
		if ("error" in c) throw new Error(c.error);
		callArgs = [c.value];
	}
	const deadline = Date.now() + PRESS_WAIT_MS;
	const out = e.actions[action](...callArgs);
	if (!(out && typeof (out as Promise<unknown>).then === "function")) {
		await quiet(deadline);
		return undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const waited = await Promise.race([
		(out as Promise<unknown>).then((v) => ({ done: true as const, v })),
		new Promise<{ done: false }>((done) => {
			timer = setTimeout(() => done({ done: false }), PRESS_WAIT_MS);
		}),
	]).finally(() => clearTimeout(timer));
	await quiet(deadline);
	return waited.done ? waited.v : "pending";
}

function stateOf(list: Entry[]): Map<string, Record<string, unknown>> {
	return new Map(list.map((e) => [e.ref, exposedState(e)]));
}

function diff(before: Map<string, Record<string, unknown>>, after: Entry[]): AgentChange[] {
	const out: AgentChange[] = [];
	for (const e of after) {
		const was = before.get(e.ref);
		if (!was) continue;
		const now = exposedState(e);
		for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
			if (same(was[k], now[k])) continue;
			out.push({
				ref: e.ref,
				component: e.component,
				label: str(e.label()),
				key: k,
				value: now[k],
				previous: was[k],
			});
		}
	}
	return out;
}

function values(list: Entry[], touched: Set<string>): { values: Record<string, unknown>; more?: number } {
	const fields = list.filter((e) => {
		const s = exposedState(e);
		return "value" in s || "checked" in s;
	});
	const ordered = [...fields.filter((e) => touched.has(e.ref)), ...fields.filter((e) => !touched.has(e.ref))];
	const out: Record<string, unknown> = {};
	for (const e of ordered.slice(0, SNAPSHOT_LIMIT)) {
		const s = exposedState(e);
		out[name(e)] = "value" in s ? s.value : s.checked;
	}
	return ordered.length > SNAPSHOT_LIMIT ? { values: out, more: ordered.length - SNAPSHOT_LIMIT } : { values: out };
}

function refuse(e: Entry, step: AgentStep): string | null {
	if (!(step.action in e.actions)) {
		const takes = Object.keys(e.actions);
		return (
			e.component +
			" " +
			e.ref +
			" takes no " +
			step.action +
			". It takes: " +
			(takes.length ? takes.join(", ") : "nothing") +
			"."
		);
	}
	if (e.disabled?.()) return `${name(e)} is disabled now.`;
	const confirm = marks(e).confirm;
	if (confirm) return `Needs a person: "${confirm}". Ask them to press "${str(e.label()) ?? e.ref}" themselves.`;
	return argError(e, step.action, step.args ?? []);
}

/** Runs steps in order. A failed step stops the call; earlier steps stay applied. */
export async function act(steps: AgentStep[]): Promise<ActResult> {
	collectChanges();
	acting = true;
	const startRefs = new Set(entries.keys());
	const done: ActResult["steps"] = [];
	const touched = new Set<string>();
	let error: ActResult["error"];
	try {
		for (const [i, step] of steps.entries()) {
			const found = resolve(step.ref, visibleEntries(), step.action);
			if ("error" in found) {
				error = { step: i, message: found.error };
				break;
			}
			const e = found.entry;
			const refused = refuse(e, step);
			if (refused) {
				error = { step: i, message: refused };
				break;
			}
			const before = stateOf(visibleEntries());
			const refsBefore = new Set(entries.keys());
			blocked = [];
			try {
				const result = await run(e, step.action, step.args ?? []);
				if (blocked.length > 0) {
					error = {
						step: i,
						message:
							'Needs a person: "' +
							(str(e.label()) ?? e.ref) +
							'" writes to Pilot (' +
							blocked[0] +
							"). Nothing was sent. Ask them to press it themselves.",
					};
					break;
				}
				const stepChanges = diff(before, visibleEntries());
				const gone = [...refsBefore].filter((r) => !entries.has(r));
				touched.add(e.ref);
				for (const l of actedListeners) l(e.ref);
				done.push({
					step: i,
					ref: e.ref,
					...(result !== undefined ? { result } : {}),
					...(stepChanges.length ? { changes: stepChanges } : {}),
					...(gone.length ? { gone } : {}),
				});
			} catch (err) {
				error = { step: i, message: err instanceof Error ? err.message : String(err) };
				break;
			}
		}
	} finally {
		// The agent's own changes are not news for its next snapshot: they become the new baseline.
		const placed = await place(visibleEntries());
		remember(placed.map(describe));
		acting = false;
	}
	const now = visibleEntries();
	const appeared = now.filter((e) => !startRefs.has(e.ref)).map(name);
	const open = now.filter((e) => touched.has(e.ref) && exposedState(e).open === true).map(name);
	return {
		ok: !error,
		...(error ? { error } : {}),
		steps: done,
		...(appeared.length ? { appeared } : {}),
		...(open.length ? { open } : {}),
		...values(now, touched),
	};
}

/** Whether an agent step is running now. A control may read it to tell the agent's input from a person's. */
export function agentActing(): boolean {
	return acting;
}

/** Where a control is in the window, in the root view's points. */
export type AgentFrame = { x: number; y: number; width: number; height: number };

async function frame(e: Entry): Promise<AgentFrame | null> {
	const m = e.node ? await e.node.measure().catch(() => null) : null;
	if (!m) return null;
	return { x: m.pagePosition.x, y: m.pagePosition.y, width: m.bounds.size.width, height: m.bounds.size.height };
}

/** The frame of the control with ref `ref` now, or null when it left or has no view. */
export async function frameOf(ref: string): Promise<AgentFrame | null> {
	const e = entries.get(ref);
	return e && !marks(e).hidden ? frame(e) : null;
}

/** The smallest visible control under a point, for pointing at what the person means. */
export async function controlAt(
	x: number,
	y: number,
): Promise<{ ref: string; component: string; label?: string; frame: AgentFrame } | null> {
	let best: { e: Entry; f: AgentFrame } | null = null;
	for (const e of visibleEntries()) {
		const f = await frame(e);
		if (!f || x < f.x || y < f.y || x > f.x + f.width || y > f.y + f.height) continue;
		if (!best || f.width * f.height < best.f.width * best.f.height) best = { e, f };
	}
	return best ? { ref: best.e.ref, component: best.e.component, label: str(best.e.label()), frame: best.f } : null;
}

const actedListeners = new Set<(ref: string) => void>();

/** Hears each control an agent step acted on, to mark it on screen for a moment. */
export function onActed(listener: (ref: string) => void): () => void {
	actedListeners.add(listener);
	return () => actedListeners.delete(listener);
}
