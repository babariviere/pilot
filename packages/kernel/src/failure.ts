/** Small display diagnostics, not exception serialization. Never retain stacks, headers or payloads. */
export const MAX_FAILURE_CHARS = 1600;
const MAX_SCAN_CHARS = 64_000;
const MAX_CAUSES = 4;
const SECRET_NAME = /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;
const RETRYABLE_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Redact before clipping, including credentials embedded in commands and signed URLs. */
export function safeFailureText(value: string, max = MAX_FAILURE_CHARS): string {
	// Oversized exception dumps are not diagnostics. Omit them rather than scanning unbounded
	// payloads or clipping through an unknown credential before redaction.
	if (value.length > MAX_SCAN_CHARS) return clip("[oversized error text omitted]", max);
	let text = value;
	for (const [name, secret] of Object.entries(process.env)) {
		if (SECRET_NAME.test(name) && secret && secret.length >= 4) text = text.replaceAll(secret, "[redacted]");
	}
	text = text
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]")
		.replace(
			/\b((?:authorization|cookie|set-cookie)\s*:\s*)([^\r\n"']+)/gi,
			(_match, prefix: string, body: string) => `${prefix}${body.startsWith("[redacted]") ? body : "[redacted]"}`,
		)
		.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
			try {
				const parsed = new URL(url);
				return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search || parsed.hash ? "?[redacted]" : ""}`;
			} catch {
				return "[redacted URL]";
			}
		})
		.replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
		.replace(
			/\b((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w-]*)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
			(_match, prefix: string, secret: string) =>
				`${prefix}${secret.startsWith("[redacted]") ? secret : "[redacted]"}`,
		)
		.replace(
			/(--[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w-]*\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
			(_match, prefix: string, secret: string) =>
				`${prefix}${secret.startsWith("[redacted]") ? secret : "[redacted]"}`,
		)
		.replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[redacted]")
		.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")
		.replace(/[\u0000-\u001f\u007f]/g, " ");
	return clip(text, max);
}

function field(value: unknown, name: string): unknown {
	try {
		return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
	} catch {
		return undefined;
	}
}

/** A whitelisted, cycle-safe cause chain. Network classification never authorizes replaying tools. */
export function formatFailure(error: unknown, step?: string): string {
	const causes: string[] = [];
	const seen = new Set<unknown>();
	let current = error;
	let retryable = false;
	for (let depth = 0; current !== undefined && current !== null && depth < MAX_CAUSES; depth++) {
		if (seen.has(current)) break;
		seen.add(current);
		const code = field(current, "code");
		if (typeof code === "string" && RETRYABLE_CODES.has(code)) retryable = true;
		const message = field(current, "message");
		const errors = field(current, "errors");
		const nested = field(current, "cause") ?? (Array.isArray(errors) ? errors[0] : undefined);
		const parts = [
			safeFailureText(
				typeof message === "string" ? message : typeof current === "string" ? current : "Unknown error",
				nested == null && depth === 0 ? MAX_FAILURE_CHARS : 300,
			),
		];
		for (const key of ["code", "hostname", "host", "syscall"] as const) {
			const value = field(current, key);
			if (typeof value === "string" || typeof value === "number")
				parts.push(`${key}=${safeFailureText(String(value), 100)}`);
		}
		causes.push(parts.join("; "));
		current = nested;
	}
	if (current !== undefined && current !== null) causes.push("…");
	return safeFailureText(
		`${step ? `${safeFailureText(step, 220)}: ` : ""}${retryable ? "Retryable network error. " : ""}${causes.join(" → ")}`,
	);
}

export function toolFailureStep(name: string, args: unknown): string {
	const command = field(args, "command");
	return `Tool ${name}${typeof command === "string" ? ` (${safeFailureText(command, 180)})` : ""}`;
}

/** Preserve the exception for provider retries; observe only this request's last fetch. */
export function diagnosticFetch(
	fetch: typeof globalThis.fetch,
	observe: (error: unknown) => void,
): typeof globalThis.fetch {
	return async (input, init) => {
		try {
			const response = await fetch(input, init);
			observe(undefined);
			return response;
		} catch (error) {
			observe(error);
			throw error;
		}
	};
}
