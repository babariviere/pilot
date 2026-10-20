/**
 * Privacy and prompt-injection safeguards for text quoted from a chat's retained history. Every function returns a new
 * string: stored transcripts are never rewritten, so redaction applies only to what history recall and extractive
 * summaries put back in front of the model.
 */

/** The most text one call redacts. Callers clip or page longer text before redaction. */
export const MAX_REDACT_CHARS = 256_000;

const SECRET_NAME =
	/(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?id)/i;
const SECRET_ENV_NAME = /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)/i;

/** Distinctive provider credential formats. Each is anchored on a fixed prefix, so the scan stays linear. */
const TOKEN_FORMATS =
	/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
	const values: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value && value.length >= 8 && SECRET_ENV_NAME.test(name) && !/^(?:true|false|\d+)$/i.test(value))
			values.push(value);
	}
	// Longest first, so a secret that contains another is replaced whole.
	return values.sort((a, b) => b.length - a.length);
}

function bitsPerChar(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/** Counts, flags and empty markers are not credentials, even under a credential-like name ("max tokens: 4096"). */
function inertValue(value: string): boolean {
	return /^["']?(?:\d{1,6}|true|false|null|none|undefined|\*+)["']?$/i.test(value);
}

/** Long mixed-case alphanumeric runs with high entropy. Hex (commit hashes) and word-like identifiers stay. */
function opaqueSecret(token: string): boolean {
	return (
		!/^[0-9a-f]+$/i.test(token) &&
		/[0-9]/.test(token) &&
		/[a-z]/.test(token) &&
		/[A-Z]/.test(token) &&
		bitsPerChar(token) >= 4.2
	);
}

/**
 * Conservative redaction of credentials in quoted history. Keeps commit hashes, change IDs, paths and ordinary
 * identifiers so recall and summaries stay useful. Text longer than {@link MAX_REDACT_CHARS} is clipped first, so a
 * clip never cuts through a secret that redaction did not see.
 */
export function redactHistoryText(input: string, env: NodeJS.ProcessEnv = process.env): string {
	let text = input.length > MAX_REDACT_CHARS ? input.slice(0, MAX_REDACT_CHARS) : input;
	for (const secret of environmentSecrets(env))
		if (text.includes(secret)) text = text.replaceAll(secret, "[redacted]");
	return (
		text
			.replace(
				/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
				"[redacted private key]",
			)
			.replace(
				/\b((?:authorization|proxy-authorization|cookie|set-cookie)\s{0,4}:\s{0,4})[^\r\n]{1,2048}/gi,
				"$1[redacted]",
			)
			.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]")
			// Prove the authority ends in @ before matching user:password, so colon-rich URLs cannot backtrack.
			.replace(/:\/\/(?=[^\s/@]{1,512}@)[^\s/@:]{1,256}:[^\s/@]{1,256}@/g, "://[redacted]@")
			.replace(
				/([?&](?:access_token|token|key|api_key|apikey|sig|signature|auth|password|secret|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&#\s"'<>]{1,2048}/gi,
				"$1[redacted]",
			)
			// A field name is matched once from its word start, never retried at every character.
			.replace(
				/(?<![\w.-])([\w.-]{1,64})(["']?\s{0,4}[=:]\s{0,4})("[^"\r\n]{1,1024}"|'[^'\r\n]{1,1024}'|[^\s,;"'\])}]{1,1024})/g,
				(match, name: string, separator: string, value: string) =>
					SECRET_NAME.test(name) && !value.startsWith("[redacted") && !inertValue(value)
						? `${name}${separator}[redacted]`
						: match,
			)
			.replace(
				/(--[\w-]{1,64})(=|\s{1,4})("[^"\r\n]{1,1024}"|'[^'\r\n]{1,1024}'|[^\s"']{1,1024})/g,
				(match, flag: string, separator: string) =>
					SECRET_NAME.test(flag) ? `${flag}${separator}[redacted]` : match,
			)
			.replace(TOKEN_FORMATS, "[redacted]")
			.replace(/[A-Za-z0-9+_=-]{32,512}/g, (token) => (opaqueSecret(token) ? "[redacted]" : token))
	);
}

/**
 * Remove characters that hide or reorder text, and defang tags that frame model context, so quoted history cannot
 * close a summary block or pose as a system, tool or instruction section.
 */
export function neutralizeUntrusted(text: string): string {
	return text
		.replace(
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
			"",
		)
		.replace(
			/<(\/?)(summary|system|untrusted|instructions?|tool[\w-]*|assistant|user|conversation|context|pilot[\w-]*)(?=[\s>/])/gi,
			"‹$1$2",
		);
}

/** Redacted, neutralized and whitespace-collapsed: a quote on one line cannot forge headings or sections. */
export function quoteLine(text: string, max: number): string {
	const line = neutralizeUntrusted(redactHistoryText(text)).replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const GRANT =
	/\b(?:permissions? (?:to|granted|is granted)|permitted|approv(?:e|ed|es|ing)|authori[sz](?:e|ed|es|ing)|grant(?:s|ed|ing)?|full[- ]access|allowed to|ok(?:ay)?,? go(?: do| ahead)?\b|go ahead and|(?:you |we )?(?:may|can) (?:now )?(?:push|publish|merge|deploy|release|install|delete|commit))\b/i;
const RESTRICTIVE =
	/\b(?:revok\w*|withdraw\w*|defer\w*|no longer|do not|don't|never|must not|not allowed|stop|deny|denied|without (?:new |explicit |further )?(?:approval|permission|consent)|blocked)\b/i;
const OPERATIONAL_WORDS =
	"install\\w*|publish\\w*|PRs?|pull requests?|merg\\w*|deploy\\w*|push\\w*|commit\\w*|paid|spend\\w*|provider calls?|benchmark calls?|workers?|source(?:\\/implementation)? changes?|implementation changes?|live[- ]history|mission changes?|rollout|enablement|releases?|credentials?|secrets?|delet\\w*|destructive|external";
const OPERATIONAL = new RegExp(`\\b(?:${OPERATIONAL_WORDS})\\b`, "i");
/** A negation that governs an operational action within a few words: "no installs", "NO source changes". */
const NEGATED_OPERATION = new RegExp(
	`\\b(?:no|not|never|nor|without|avoid|forbid\\w*)\\s+(?:[\\w/'-]+[\\s,]+){0,3}?(?:${OPERATIONAL_WORDS})\\b`,
	"i",
);
/** Clause boundaries that commonly join a narrow grant to a restriction in one sentence. */
const CLAUSE = /;\s+|,\s*(?:but|except|however|while)\s+|\s+but\s+/i;

function clauseKind(clause: string): "grant" | "restriction" | undefined {
	if (RESTRICTIVE.test(clause) || NEGATED_OPERATION.test(clause)) return "restriction";
	return GRANT.test(clause) ? "grant" : undefined;
}

/**
 * How historical prose bears on authority. A grant is never carried forward: Pilot's current state decides
 * permissions. A restriction is kept, labeled historical, since honoring an outdated limit is the safe error.
 * Mixed sentences count as restrictions; splitAuthority separates their parts.
 */
export function authorityKind(sentence: string): "grant" | "restriction" | undefined {
	const kinds = sentence.split(CLAUSE).map(clauseKind);
	return kinds.includes("restriction") ? "restriction" : kinds.includes("grant") ? "grant" : undefined;
}

export type AuthoritySplit = {
	/** Restriction clauses, verbatim. */
	restrictions: string[];
	/** Grant clauses removed or defanged. */
	grants: number;
	/** The sentence without restriction clauses or operational grants, with any other approval wording replaced. */
	rest: string;
};

/**
 * Separate a historical sentence into restrictions and the rest. A grant clause about an operational action
 * ("you may push") is dropped whole; other approval wording ("User approved X to fix Y") is replaced, so the task
 * it scopes survives without the approval.
 */
export function splitAuthority(sentence: string): AuthoritySplit {
	const restrictions: string[] = [];
	const rest: string[] = [];
	let grants = 0;
	for (const clause of sentence.split(CLAUSE)) {
		const kind = clauseKind(clause);
		if (kind === "restriction") restrictions.push(clause.trim());
		else if (kind === "grant") {
			grants++;
			if (!OPERATIONAL.test(clause)) rest.push(clause.replace(new RegExp(GRANT.source, "gi"), "[approval omitted]"));
		} else rest.push(clause);
	}
	// Without any authority wording the sentence is returned unchanged, conjunctions included.
	if (!grants && !restrictions.length) return { restrictions, grants, rest: sentence.trim() };
	return { restrictions, grants, rest: rest.join("; ").trim() };
}
