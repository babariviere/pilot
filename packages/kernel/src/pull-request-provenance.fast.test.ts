import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attemptsPullRequest,
	createdPullRequest,
	createsPullRequest,
	pullRequestCreation,
} from "./pull-request-provenance.ts";

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
		"gh pr create --title t --body \"$(printf '%s\\n' '## Summary' '- Uses (parentheses) and \"quotes\"')\"",
		'gh pr create --body "Intro\n$(cat /tmp/body.md)\n$(echo done)" --fill',
		'jj git push --bookmark fix/pr && gh pr create --title "$(echo fix)" --body "$( printf %s body )"',
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
		'git push --repo "$(git remote)" && gh pr create',
		'echo "`exit 0`" && gh pr create',
		'gh pr create --body "$(echo https://github.com/owner/repo/pull/12 1>&2)"',
		'gh pr create --body "$(printf x; echo https://github.com/owner/repo/pull/12)"',
		'gh pr create --body "$(cat body.md | tee /dev/stderr)"',
		'gh pr create --body "$(git log -1)"',
		'gh pr create --body "$(exit 0)"',
		'gh pr create --body "$()"',
		'gh pr create --body "$(printf \"$(echo x)\")"',
		'gh pr create --body "$(printf \"`echo x`\")"',
		'gh pr create --body "$(printf %s\necho x)"',
		'gh pr create --body "$(printf %s',
		"gh pr create --body $(printf %s body)",
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

test("help, web and bundled shorthand flags cannot claim an echoed existing PR", () => {
	for (const flag of ["-h=true", "-h=false", "-fh", "-fh=true", "-dh", "-hf", "--web", "--web=true", "-w", "-fw"])
		assert.equal(createsPullRequest(`echo ${url} && gh pr create ${flag}`), false, flag);
	assert.equal(createsPullRequest("gh pr create -tTitle-with-h --fill"), true);
	assert.equal(createsPullRequest("gh pr create -tTitle-with-w --fill"), true);
});

test("heredoc bodies, stderr merges, env prefixes, gh pr new and pipefail-guarded filters are confirmed creations", () => {
	for (const command of [
		"gh pr new --fill",
		"GH_REPO=owner/repo gh pr create --fill",
		"cd /repo && GH_PROMPT_DISABLED=1 gh pr create --fill",
		"gh pr create --fill 2>&1",
		"gh pr create --fill 2>/dev/null",
		"gh pr create --fill 2> /dev/null",
		"gh pr create --title t --body-file - <<'EOF'\n## Summary\n- Uses $HOME, $(not run) and `ticks`\nEOF",
		'gh pr create --title t --body-file - <<"EOF"\nbody\nEOF',
		"gh pr create --title t --body-file - <<-'EOF'\n\tbody\n\tEOF",
		"gh pr create --title t --body-file - <<EOF\nplain body, no expansions\nEOF",
		"jj git push --bookmark fix/pr && gh pr create --body-file - 2>&1 <<'EOF'\nbody\nEOF",
		"set -o pipefail; gh pr create --fill 2>&1 | tail -n 1",
		"set -euo pipefail\njj git push --bookmark fix/pr\ngh pr create --fill | head -1",
		"set -o pipefail && gh pr create --fill | cat",
		"set -o pipefail; gh pr create --fill 2>&1 | tail -n3 | head -n 2",
		"jj log -r @ | head -3 && gh pr create --fill",
	])
		assert.ok(createsPullRequest(command), command);
	for (const command of [
		"gh pr create --fill | tail -1",
		"gh pr create --fill 2>&1 | tail -n 1",
		"set -o pipefail; set +o pipefail; gh pr create --fill | tail -1",
		"jj log | set -o pipefail; gh pr create --fill | tail -1",
		"set -o pipefail; gh pr create --fill | grep -o 'https.*'",
		"set -o pipefail; gh pr create --fill | tail -f",
		"set -o pipefail; gh pr create --fill |",
		"set -o pipefail; gh pr create --fill | | cat",
		"set -o pipefail; gh pr create --fill |& cat",
		"gh pr create --fill > /tmp/out",
		"gh pr create --fill 2>/tmp/err",
		"gh pr create --fill 2>&2",
		"gh pr create --fill '2'>&1",
		"gh pr create --fill <<< body",
		"gh pr create --fill < body.md",
		"gh pr create --body-file - <<EOF\n$(echo https://github.com/owner/repo/pull/12 >&2)\nEOF",
		"gh pr create --body-file - <<EOF\n`echo x`\nEOF",
		"gh pr create --body-file - <<'EOF'\nbody without terminator",
		"gh pr create --body-file - <<'EOF'",
		"gh pr create --body-file - <<'EOF' && echo hi\nbody\nEOF",
		"gh pr create --body-file - <<'EOF'\nbody\nEOF\ngh pr view 12",
		"cat <<'EOF'\nhttps://github.com/owner/repo/pull/12\nEOF\ngh pr create --fill",
		"GH_REPO=x gh pr view 12",
		"gh pr new --help",
	])
		assert.equal(createsPullRequest(command), false, command);
});

test("an unconfirmed gh PR creation is an attempt, except help or failures without a PR URL", () => {
	const bash = (command: string, structuredContent?: unknown) => ({
		toolName: "bash",
		input: { command },
		content: [{ type: "text", text: url }],
		...(structuredContent ? { structuredContent } : {}),
	});
	assert.deepEqual(pullRequestCreation(bash("gh pr create --fill")), { url });
	for (const command of [
		"gh pr create --fill | tail -1",
		"gh pr create --fill 2>&1 | grep -o 'https.*'",
		"(gh pr create --fill)",
		"jj git push && gh pr new --fill; echo done",
	])
		assert.deepEqual(
			pullRequestCreation(bash(command, { exit_code: 0, output: "done" })),
			{ attempted: true },
			command,
		);
	assert.deepEqual(
		pullRequestCreation(bash("gh pr create --fill 2>&1", { exit_code: 0, output: "Warning: 1 uncommitted change" })),
		{ attempted: true },
		"a confirmed command whose output has no URL",
	);
	assert.equal(pullRequestCreation(bash("gh pr create --fill | tail -1", { exit_code: 1, output: "" })), undefined);
	assert.equal(
		pullRequestCreation({ ...bash("gh pr create --fill | tail -1", { output: "creation failed" }), isError: true }),
		undefined,
	);
	assert.equal(pullRequestCreation({ ...bash("gh pr create --fill | tail -1"), toolName: "read" }), undefined);
	for (const command of [
		"gh pr view 12",
		"gh pr create --help | cat",
		"gh pr create -h",
		"gh pr create --dry-run | cat",
		"ghx pr create",
		"echo gh pr creates",
	])
		assert.equal(attemptsPullRequest(command), false, command);
});

test("a failed shell with a creation command and bare PR URL requests reconciliation, never claims ownership", () => {
	const command = "gh pr create --head fix/pr --fill; gh pr view --head fix/pr --json number";
	const output = `${url}\nunknown flag: --head\nUsage: gh pr view [flags]\n`;
	for (const failure of [
		{ structuredContent: { exit_code: 1, output } },
		{ isError: true, structuredContent: { exit_code: 1, output } },
		{ isError: true, content: [{ type: "text", text: output }] },
	]) {
		const failed = { ...result, input: { command }, ...failure };
		assert.equal(createdPullRequest(failed), undefined);
		assert.deepEqual(pullRequestCreation(failed), { attempted: true });
		for (const unrelated of ["gh pr view 12", "gh pr create --help", "gh pr create --dry-run"])
			assert.equal(pullRequestCreation({ ...failed, input: { command: unrelated } }), undefined);
		assert.equal(pullRequestCreation({ ...failed, toolName: "read" }), undefined);
	}
	for (const output of ["creation failed", `See ${url}`, url.replace("/pull/", "/issues/"), `${url}?query=1`])
		assert.equal(
			pullRequestCreation({ ...result, input: { command }, structuredContent: { exit_code: 1, output } }),
			undefined,
		);
});
