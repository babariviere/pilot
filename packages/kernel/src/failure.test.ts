import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticFetch, formatFailure, MAX_FAILURE_CHARS, safeFailureText, toolFailureStep } from "./failure.ts";

export function nestedFetchError() {
	return new TypeError("fetch failed", {
		cause: new Error("socket closed", {
			cause: Object.assign(new Error("connect failed"), {
				code: "ECONNRESET",
				hostname: "api.example.com",
				syscall: "connect",
				headers: { authorization: "never-serialize-headers" },
			}),
		}),
	});
}

test("nested fetch causes retain network code, hostname and syscall with an advisory retry label", () => {
	const text = formatFailure(nestedFetchError(), "Model request (example/model)");
	assert.match(text, /^Model request \(example\/model\): Retryable network error\./);
	assert.match(text, /fetch failed → socket closed → connect failed/);
	assert.match(text, /code=ECONNRESET; hostname=api.example.com; syscall=connect/);
	assert.doesNotMatch(text, /never-serialize|stack/);
});

test("cycles, deep chains, aggregate causes and hostile fields are bounded", () => {
	const cycle = new Error("cycle");
	cycle.cause = cycle;
	assert.equal(formatFailure(cycle), "cycle → …");
	let error = new Error("oldest");
	for (let i = 0; i < 20; i++) error = new Error(String(i).repeat(1000), { cause: error });
	const text = formatFailure(error, "x".repeat(1000));
	assert.ok(text.length <= MAX_FAILURE_CHARS);
	assert.doesNotMatch(text, /oldest/);
	assert.match(formatFailure(new AggregateError([nestedFetchError()], "connect attempts")), /ECONNRESET/);
	assert.equal(
		formatFailure({
			get message() {
				throw new Error("do not call me");
			},
		}),
		"Unknown error",
	);
});

test("permanent errors and generic fetch text are not guessed retryable", () => {
	assert.doesNotMatch(formatFailure(new Error("fetch failed")), /Retryable/);
	assert.doesNotMatch(
		formatFailure(Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" })),
		/Retryable/,
	);
});

test("redaction precedes clipping and covers nested messages, commands, headers, URLs and known secrets", (t) => {
	const previous = process.env.EXAMPLE_API_TOKEN;
	process.env.EXAMPLE_API_TOKEN = "opaque-example-value";
	t.after(() => {
		if (previous === undefined) delete process.env.EXAMPLE_API_TOKEN;
		else process.env.EXAMPLE_API_TOKEN = previous;
	});
	const raw = `TOKEN="two words" --password 'more words' api_key=abc Bearer bearer-value https://alice:pass@api.example.com/path?signature=url-value#fragment ghp_example opaque-example-value`;
	const result = formatFailure(
		new Error(raw, { cause: new Error("secret=cause-value") }),
		toolFailureStep("bash", { command: raw }),
	);
	for (const secret of [
		"two words",
		"more words",
		"abc",
		"bearer-value",
		"alice",
		"url-value",
		"ghp_example",
		"opaque-example-value",
		"cause-value",
	])
		assert.ok(!result.includes(secret), secret);
	assert.match(result, /Tool bash/);
	assert.match(result, /api.example.com\/path/);
	assert.ok(safeFailureText(`password=${"secret".repeat(1000)}`, 30).length <= 30);
	assert.doesNotMatch(safeFailureText("Cookie: sid=first-value; session=second-value"), /first-value|second-value/);
	assert.doesNotMatch(safeFailureText('TOKEN="line one\nline two"'), /line one|line two/);
	assert.equal(
		safeFailureText(safeFailureText(raw)),
		safeFailureText(raw),
		"redaction stays stable through IPC/persistence",
	);
	assert.equal(safeFailureText("x".repeat(1_000_000)), "[oversized error text omitted]");
	assert.equal(
		safeFailureText("Maximum tokens allowed; token limit exceeded"),
		"Maximum tokens allowed; token limit exceeded",
	);
});

test("fetch observation preserves exception identity, custom fetch arguments and clears recovered failures", async () => {
	const error = nestedFetchError();
	const observed: unknown[] = [];
	const init = { method: "POST" };
	let calls = 0;
	const fetch = diagnosticFetch(
		async (input, actual) => {
			assert.equal(input, "https://example.com");
			assert.equal(actual, init);
			if (++calls === 1) throw error;
			return new Response("ok");
		},
		(failure) => observed.push(failure),
	);
	await assert.rejects(fetch("https://example.com", init), (caught) => caught === error);
	assert.equal(await (await fetch("https://example.com", init)).text(), "ok");
	assert.deepEqual(observed, [error, undefined]);
});
