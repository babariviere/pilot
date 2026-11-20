/** Conservative redaction before search, clipping, JSON quoting or in-memory log retention. */
export function isCredentialField(key: string): boolean {
	return /^(?:auth|authentication)$|key$|authorization|cookie|token|secret|password|passwd|credential/i.test(key);
}

export function redactDiagnosticText(text: string): string {
	if (/-----\s*(?:BEGIN|END)[^\n]*(?:PRIVATE KEY|OPENSSH|PGP)/i.test(text)) return "[REDACTED private-key material]";
	if (/(?:key|auth|authorization|token|secret|password|credential)[\\"'\s]*[:=][ \t]*\r?\n/i.test(text))
		return "[REDACTED multiline credential record]";
	return text
		.split("\n")
		.map((line) => {
			// Decode structured escapes only when present, keeping ordinary log lines cheap.
			let check = line;
			if (/[\\%]/.test(line)) {
				for (const start of [0, line.indexOf("] ") + 2]) {
					try {
						check = line.slice(0, start) + JSON.stringify(JSON.parse(line.slice(start)));
						break;
					} catch {}
				}
				try {
					check = decodeURIComponent(check);
				} catch {}
			}
			// Start once per complete field name. Retrying a greedy credential-name
			// pattern at every character makes long adversarial records quadratic.
			for (const field of check.matchAll(/(?<![\w-])([\w-]+)[\\"' \t]*[:=]/g)) {
				if (isCredentialField(field[1]!)) return "[REDACTED credential-bearing record]";
			}
			// Prove the authority ends in @ before trying user:password. Otherwise a colon-rich
			// noncredential URL makes the two overlapping character classes backtrack quadratically.
			return /\b(?:Bearer|Basic)\s+\S+|:\/\/(?=[^\s/@]*@)[^\s/@]+:[^\s/@]+@|[?&](?:sig|signature|key|auth)=|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/i.test(
				check,
			)
				? "[REDACTED credential-bearing record]"
				: check !== line && /[A-Za-z0-9+/_=-]{40,}/.test(check)
					? "[REDACTED encoded opaque value]"
					: line.replace(/[A-Za-z0-9+/_=-]{40,}/g, "[REDACTED opaque value]");
		})
		.join("\n");
}
