/** Runs Day modules under Node. NSH, the UI barrel and every `.tsx` view module are stubbed: Node cannot run
 * JSX, and these tests check data flow, not drawing. */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const ui = new URL("../../ui", import.meta.url).href;

const nsh = `export const host = globalThis.__dayTestHost;
export function signal(value) { const read = () => value; read.set = (v) => { value = v }; read.update = (f) => { value = f(value) }; return read; }
export function effect() {}
export function cleanup() {}
export function untracked(read) { return read() }
export function lifecycle() { return "active" }
export function context() { return undefined }
export function windowSize() { return { width: 1100, height: 800 } }`;

/** Each export of a stubbed module calls the matching function in `presentation`, or returns undefined.
 * Exported signals stay signals, so Day modules can still set them. */
function stubModule(names: Iterable<string>, signals: Iterable<string> = []): string {
	return [
		'import { signal } from "nsh";',
		...[...new Set(signals)].map((name) => `export const ${name} = signal(null);`),
		...[...new Set(names)].map(
			(name) =>
				`export function ${name}(...args) { return globalThis.__dayPresentation[${JSON.stringify(name)}]?.(...args) }`,
		),
	].join("\n");
}

/** Day sources import siblings without an extension, as NSH resolves them. */
export function stubNsh(host: unknown, presentation: Record<string, (...args: never[]) => unknown> = {}) {
	Object.assign(globalThis, { __dayTestHost: host, __dayPresentation: presentation });
	registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "nsh") return { url: "test:nsh", shortCircuit: true };
			if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
				if (new URL(specifier, context.parentURL).href === ui) return { url: "test:ui", shortCircuit: true };
				const url = new URL(`${specifier}.ts`, context.parentURL);
				if (existsSync(fileURLToPath(url))) return next(url.href, context);
				const view = new URL(`${specifier}.tsx`, context.parentURL);
				if (existsSync(fileURLToPath(view))) return { url: `test:view:${view.href}`, shortCircuit: true };
			}
			return next(specifier, context);
		},
		load(url, context, next) {
			if (url === "test:nsh") return { format: "module", shortCircuit: true, source: nsh };
			if (url === "test:ui") return { format: "module", shortCircuit: true, source: stubModule(["glide"]) };
			if (url.startsWith("test:view:")) {
				const source = readFileSync(new URL(url.slice(10)), "utf8");
				const signals = [...source.matchAll(/^export const (\w+) = signal\b/gm)].map((match) => match[1]!);
				const names = [...source.matchAll(/^export (?:async )?(?:function\*?|const|let|class) (\w+)/gm)]
					.map((match) => match[1]!)
					.filter((name) => !signals.includes(name));
				return { format: "module", shortCircuit: true, source: stubModule(names, signals) };
			}
			return next(url, context);
		},
	});
}
