import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolHooks } from "@earendil-works/pi-durable";
import { messageFormatBlock } from "./message-format.ts";
import { withPilotPolicy } from "./policy.ts";
import { commandArguments, nativeToolPolicy } from "./tool-policy.ts";

const bad = [
	String.raw`jj describe -m "feat: change\n\nDetails"`,
	String.raw`jj desc --message='feat: change\nDetails'`,
	String.raw`jj commit -m'fix: change\nDetails'`,
	String.raw`jj ci --message "fix: change\nDetails"`,
	String.raw`jj new -m "fix: change\nDetails"`,
	String.raw`/usr/bin/git -C /repo commit --message="fix: change\nDetails"`,
	String.raw`env FOO=bar command jj --repository /repo describe -m "fix: change\nDetails"`,
	String.raw`gh -R owner/repo pr create --title='Title\nDetails'`,
	String.raw`gh pr edit 12 -b'Body\nDetails'`,
	String.raw`echo ready && gh pr create --body "Body\nDetails"`,
	String.raw`jj describe -m "Title
Actual line and literal\nDetails"`,
];
const good = [
	'jj describe -m "Title\n\nDetails"',
	"jj describe -m 'Title' -m 'Details'",
	String.raw`jj describe -m $'Title\n\nDetails'`,
	String.raw`gh pr create --body $'Body\nDetails'`,
	"jj describe --stdin <<'EOF'\nTitle\n\nDetails\nEOF",
	"gh pr create --body-file /tmp/body.md",
	String.raw`echo 'jj describe -m "Title\nDetails"'`,
	String.raw`echo jj describe -m 'Title\nDetails'`,
	String.raw`rg '\n' file.ts`,
	String.raw`jj log -m 'Title\nDetails'`,
	"gh pr view 12 --json body",
	String.raw`# jj describe -m 'Title\nDetails'`,
];

test("reject literal newline escapes only in inline commit and PR message flags", () => {
	for (const command of bad)
		assert.match(messageFormatBlock("bash", { command }, command)!, /Nothing was executed.*Reformat/);
	for (const command of good) assert.equal(messageFormatBlock("bash", { command }, command), undefined, command);
	assert.equal(messageFormatBlock("write", {}, undefined), undefined);
	assert.match(
		messageFormatBlock(
			"mcp__github__create_pull_request",
			{ title: "Title", body: String.raw`Body\nDetails` },
			undefined,
		)!,
		/actual line breaks/,
	);
});

test("Harness guards shell/jobs calls without interpreting codemode source escapes", async () => {
	const extension = withPilotPolicy({ name: "test" }, {});
	const before = (extension.hooks![0]!.handlers as Pick<ToolHooks, "beforeTool">).beforeTool;
	for (const command of bad) {
		for (const [name, args] of [
			["bash", { command }],
			["jobs", { action: "start", command }],
		] as const) {
			assert.ok(
				(
					await before(
						{ type: "toolCall", id: "test", name, arguments: args },
						undefined as never,
						undefined as never,
					)
				)?.block,
			);
		}
	}
	const code = `await tools.bash({command: ${JSON.stringify(good[0])}})`;
	assert.equal(messageFormatBlock("codemode", { code }, code), undefined);
	assert.equal(commandArguments("jobs", { action: "stop", command: bad[0] }), undefined);
});

test("native policy rejects actual dynamically constructed nested tool arguments", () => {
	let check: (event: { toolName: string; input: Record<string, unknown> }) => unknown;
	nativeToolPolicy()({
		on: (event: string, handler: typeof check) => {
			if (event === "tool_call") check = handler;
		},
	} as never);
	for (const command of bad)
		assert.equal((check!({ toolName: "bash", input: { command } }) as { block: boolean }).block, true);
	for (const command of good) assert.equal(check!({ toolName: "bash", input: { command } }), undefined);
});
