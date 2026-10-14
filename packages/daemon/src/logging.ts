import { format } from "node:util";

const methods = ["log", "info", "warn", "error", "debug"] as const;
type LogConsole = Pick<Console, (typeof methods)[number]>;

/** Install only at the daemon entry point, before loading services or extensions. Keep printf formatting. */
export function timestampConsole(target: LogConsole = console, now = () => new Date()): void {
	for (const method of methods) {
		const write = target[method].bind(target);
		target[method] = (...args: unknown[]) => {
			const prefix = `[${now().toISOString()}] `;
			write(prefix + format(...args).replaceAll("\n", `\n${prefix}`));
		};
	}
}
