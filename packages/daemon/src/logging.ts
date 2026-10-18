import { format } from "node:util";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";

const MAX_RING_BYTES = 64 * 1024;
const MAX_RING_RECORDS = 512;
const recent: string[] = [];
let recentBytes = 0;
let dropped = false;

/** No journal subprocess. Only the bounded, redacted current-process tail is retained. */
export function daemonLogTail() {
	return { text: recent.join(""), available: true, truncated: dropped };
}

const methods = ["log", "info", "warn", "error", "debug"] as const;
type LogConsole = Pick<Console, (typeof methods)[number]>;

/** Install only at the daemon entry point, before loading services or extensions. Keep printf formatting. */
export function timestampConsole(target: LogConsole = console, now = () => new Date()): void {
	for (const method of methods) {
		const write = target[method].bind(target);
		target[method] = (...args: unknown[]) => {
			const prefix = `[${now().toISOString()}] `;
			const message = format(...args);
			// Drop oversized records entirely before redaction, never retain a partial secret.
			const safe =
				Buffer.byteLength(message) > 16_000 ? "[oversized log record omitted]" : redactDiagnosticText(message);
			const record = `${prefix}${safe.replaceAll("\n", `\n${prefix}`)}\n`;
			recent.push(record);
			recentBytes += Buffer.byteLength(record);
			while (recent.length > MAX_RING_RECORDS || recentBytes > MAX_RING_BYTES) {
				recentBytes -= Buffer.byteLength(recent.shift()!);
				dropped = true;
			}
			write(prefix + message.replaceAll("\n", `\n${prefix}`));
		};
	}
}
