import assert from "node:assert/strict";
import { test } from "node:test";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";

test("URL credentials preserve the existing nonempty user/password rules", () => {
	for (const authority of ["user:pass", "user:pass:word", ":user:pass", ":::", "user::", "::pass"])
		assert.equal(
			redactDiagnosticText(`https://${authority}@example.test/path`),
			"[REDACTED credential-bearing record]",
		);
	for (const authority of ["user", "user:", ":pass", ":", "::"])
		assert.equal(
			redactDiagnosticText(`https://${authority}@example.test/path`),
			`https://${authority}@example.test/path`,
		);
});

test("URL authority delimiters and missing credentials do not change useful text", () => {
	for (const text of [
		"https://example.test:443/path",
		"https://user:pass/path@example.test",
		"https://user:pass @example.test",
		"https://user:pass\n@example.test",
		`https://${"a:".repeat(32_000)} no credentials`,
	])
		assert.equal(redactDiagnosticText(text), text);
	assert.equal(
		redactDiagnosticText("https://not-credentials@example.test and https://user:pass@example.test"),
		"[REDACTED credential-bearing record]",
	);
});

test("URL redaction matches the previous rule exhaustively on short authorities", () => {
	const oldRule = /:\/\/[^\s/@]+:[^\s/@]+@/;
	const alphabet = ["a", ":", "@", "/", " ", "\n"];
	let authorities = [""];
	for (let length = 0; length <= 5; length++) {
		for (const authority of authorities) {
			const text = `https://${authority}@host.test`;
			const expected = text
				.split("\n")
				.map((line) => (oldRule.test(line) ? "[REDACTED credential-bearing record]" : line))
				.join("\n");
			assert.equal(redactDiagnosticText(text), expected);
		}
		authorities = authorities.flatMap((prefix) => alphabet.map((char) => prefix + char));
	}
});
