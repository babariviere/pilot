/**
 * The visual pre-check (docs/native-visuals.md): set up the visual, render the first view, then exercise every
 * control once, re-rendering and validating after each event. Synchronous once the VM exists, so the kernel runs
 * it in a worker thread (check-worker.ts).
 */
import type { VisualNode, VisualTree } from "./schema.ts";
import { VISUAL_LIMITS } from "./schema.ts";
import { VisualFailure, VisualSession, type VisualSessionOptions } from "./session.ts";

export interface VisualCheckInput extends VisualSessionOptions {
	source: string;
	/** `data` as JSON. */
	data: string;
}

export interface VisualCheckReport {
	/** Nodes in the first view. */
	nodes: number;
	/** Distinct controls seen, in the first view and the views the interactions revealed. */
	controls: number;
	/** Control events the check sent. */
	interactions: number;
	/** console output of the visual, bounded. */
	logs: string[];
}

export type VisualCheckResult =
	| { ok: true; engine: string; report: VisualCheckReport }
	| { ok: false; error: string; logs: string[] };

type Control = Extract<VisualNode, { id: string }>;

interface Step {
	id: string;
	type: Control["type"];
	value: unknown;
	/** The first state key the handler assigned, else the control's key or label. */
	name: string;
}

function describeStep(step: Step): string {
	const head = `${step.type} ${JSON.stringify(step.name)}`;
	return step.type === "button" ? head : `${head} = ${JSON.stringify(step.value)}`;
}

export async function runVisualCheck(input: VisualCheckInput): Promise<VisualCheckResult> {
	let session: VisualSession;
	try {
		session = await VisualSession.open(input);
	} catch (error) {
		return { ok: false, error: `Could not start the visual engine: ${String(error)}`, logs: [] };
	}
	try {
		const fresh = () => {
			session.load(input.source, input.data);
			return session.render().tree;
		};
		const first = fresh();
		const seen = new Set<string>();
		const queue: Array<{ prefix: Step[]; control: Control }> = [];
		const discover = (tree: VisualTree, prefix: Step[]) => {
			for (const control of controlsOf(tree.root)) {
				const signature = `${control.type}:${control.id}`;
				if (seen.has(signature)) continue;
				seen.add(signature);
				queue.push({ prefix, control });
			}
		};
		discover(first, []);
		let interactions = 0;
		while (queue.length && interactions < VISUAL_LIMITS.interactions) {
			const { prefix, control } = queue.shift()!;
			for (const values of plan(control)) {
				if (interactions + values.length > VISUAL_LIMITS.interactions) break;
				let tree = fresh();
				const steps: Step[] = [];
				const sequence = [
					...prefix.map((step) => ({ step, value: step.value })),
					...values.map((value) => ({ step: undefined, value })),
				];
				for (const { step: replay, value } of sequence) {
					const id = replay?.id ?? control.id;
					const type = replay?.type ?? control.type;
					const current = controlsOf(tree.root).find((item) => item.id === id);
					const step: Step = { id, type, value, name: replay?.name ?? nameOf(current ?? control) };
					steps.push(step);
					try {
						if (current?.type !== type)
							throw new VisualFailure(`${type} ${JSON.stringify(step.name)} is no longer in the view`);
						const changed = session.event(id, value);
						if (!replay && changed[0]) step.name = changed[0];
						tree = session.render().tree;
					} catch (error) {
						const failed = error instanceof VisualFailure ? error : new VisualFailure(String(error));
						throw new VisualFailure(
							`${failed.message} (after ${steps.map(describeStep).join(", ")})`,
							failed.line,
						);
					}
					if (!replay) {
						interactions++;
						// Controls a step reveals are exercised later, after replaying the steps that revealed them.
						discover(tree, [...steps]);
					}
				}
			}
		}
		return {
			ok: true,
			engine: session.engine,
			report: { nodes: countNodes(first.root), controls: seen.size, interactions, logs: session.logs },
		};
	} catch (error) {
		const failed = error instanceof VisualFailure ? error : new VisualFailure(String(error));
		return { ok: false, error: failed.report, logs: session.logs };
	} finally {
		session.dispose();
	}
}

export function countNodes(node: VisualNode): number {
	let count = 1;
	if ("children" in node) for (const child of node.children) count += countNodes(child as VisualNode);
	return count;
}

export function controlsOf(node: VisualNode, into: Control[] = []): Control[] {
	if ("id" in node) into.push(node as Control);
	if ("children" in node) for (const child of node.children) controlsOf(child as VisualNode, into);
	return into;
}

function nameOf(control: Control): string {
	if (control.key !== undefined) return control.key;
	if ("label" in control && control.label) return control.label;
	return control.id;
}

/** The event values to try for one control; each list starts from a fresh setup. */
function plan(control: Control): unknown[][] {
	switch (control.type) {
		case "tabs":
			return control.options.filter((option) => option.value !== control.value).map((option) => [option.value]);
		case "toggle":
			return [[!control.value, control.value]];
		case "slider":
			return [[control.min], [control.max]];
		case "button":
			return control.disabled ? [] : [null].map((value) => [value]);
	}
}
