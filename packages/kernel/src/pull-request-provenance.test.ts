import assert from "node:assert/strict";
import { test } from "node:test";
import { createdPullRequest, createsPullRequest } from "./pull-request-provenance.ts";

const url = "https://github.com/owner/repo/pull/12";
const result = { toolName: "bash", input: { command: "gh pr create --fill" }, content: [{ type: "text", text: url }] };

test("PR creation requires the actual gh command, never text in an unrelated tool or shell command", () => {
	for (const command of [
		"gh pr create --fill",
		"gh pr create --title 'A quoted title' --body \"body\"",
		"cd '/private clone' && gh pr create --draft",
		"git push -u origin fix/pr && gh pr create --fill",
		"jj git push --bookmark fix/pr && gh pr create --fill",
		"npm test && git push && gh pr create --fill",
		"jj commit -m 'feat: schema'; jj bookmark set feat/schema -r @-; jj git push --bookmark feat/schema; gh pr create --draft",
		"jj git push --bookmark feat/schema\ngh pr create --draft",
	])
		assert.ok(createsPullRequest(command), command);
	for (const command of [
		undefined,
		"gh pr view 12",
		"echo 'gh pr create'",
		"cat README.md",
		"# gh pr create",
		"false || gh pr create",
		"gh pr create | cat",
		"gh pr create; gh pr view 12",
		"gh pr create --title 'unclosed",
		"&& gh pr create",
		"git push && && gh pr create",
		"git push && gh pr create &&",
		"git push; ; gh pr create",
		"git push\nexit 0\ngh pr create",
		`if true; then echo ${url}; exit 0; fi; gh pr create`,
		`{ echo ${url}; exit 0; }; gh pr create`,
		"exec echo https://github.com/owner/repo/pull/12 && gh pr create",
		"exit 0 && gh pr create",
		"return 0 && gh pr create",
		"eval 'exit 0' && gh pr create",
		"source script.sh && gh pr create",
		". script.sh && gh pr create",
		"A=b command -- exec echo https://github.com/owner/repo/pull/12 && gh pr create",
		"gh pr create --help",
		"gh pr create -h",
		"gh pr create --help=true",
		"gh pr create --dry-run",
		"gh pr create --dry-run=true",
		'gh pr create --title "$(echo https://github.com/owner/repo/pull/12 >&2)"',
		'gh pr create --help --title "$(echo https://github.com/owner/repo/pull/12 >&2)"',
		'gh pr create --title "`echo https://github.com/owner/repo/pull/12`"',
		'git push --repo "$(echo origin)" && gh pr create',
		'echo "`exit 0`" && gh pr create',
	])
		assert.equal(createsPullRequest(command), false, String(command));
	for (const toolName of ["read", "write", "codemode", "grep", "mcp__github__get_pull_request"])
		assert.equal(createdPullRequest({ ...result, toolName }), undefined);
});

test("PR results require success and one bare HTTPS pull URL from that matching result", () => {
	assert.equal(createdPullRequest(result), url);
	for (const command of ["git push && gh pr create", "jj git push --bookmark fix/pr && gh pr create"])
		assert.equal(createdPullRequest({ ...result, input: { command } }), url);
	assert.equal(
		createdPullRequest({
			...result,
			input: { command: "jj commit -m 'feat: schema'; jj git push --bookmark feat/schema; gh pr create --draft" },
			structuredContent: { exit_code: 0, output: `Working copy now at: empty\n${url}\n` },
		}),
		url,
	);
	assert.equal(createdPullRequest({ ...result, structuredContent: { exit_code: 0, output: `${url}\n` } }), url);
	assert.equal(createdPullRequest({ ...result, isError: true }), undefined);
	assert.equal(createdPullRequest({ ...result, structuredContent: { exit_code: 1, output: url } }), undefined);
	for (const text of [
		`Created ${url}`,
		`[PR](${url})`,
		url.replace("https:", "http:"),
		url.replace("/pull/", "/issues/"),
		`${url}\nhttps://github.com/other/repo/pull/42`,
		`${url}?other=1`,
		`Usage: gh pr create [flags]\n${url}`,
		`warning: stderr contains a link\n${url}`,
	])
		assert.equal(createdPullRequest({ ...result, content: [{ type: "text", text }] }), undefined, text);
	assert.equal(createdPullRequest({ ...result, input: { command: "gh pr view 12" } }), undefined);
});

test("shorthand help and bundled help flags cannot claim an echoed existing PR", () => {
	for (const flag of ["-h=true", "-h=false", "-fh", "-fh=true", "-dh", "-hf"])
		assert.equal(createsPullRequest(`echo ${url} && gh pr create ${flag}`), false, flag);
	assert.equal(createsPullRequest("gh pr create -tTitle-with-h --fill"), true);
});
