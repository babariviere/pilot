import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import type { GitHubAction } from "@pilot/protocol";
import {
	actionText,
	appendGitHubAction,
	GitHubActionsDoc,
	githubActions,
	githubCommandSummaries,
} from "./github-actions.ts";

const summaries = (command: string) => githubCommandSummaries("bash", { command }).summaries;
test("write summaries retain operations and validated targets, never bodies or credentials", () => {
	assert.deepEqual(summaries("gh pr ready 12"), [
		{ kind: "pr_ready", prNumber: 12, summary: "gh pr ready", target: "PR #12", description: "marked PR #12 ready" },
	]);
	assert.equal(
		summaries("gh pr ready https://github.com/example/repo/pull/12 --undo")[0]?.description,
		"marked PR #12 draft",
	);
	assert.equal(summaries("git -C /tmp push -u origin feat/a")[0]?.target, "feat/a");
	assert.equal(summaries("jj git push --bookmark feat/a")[0]?.target, "feat/a");
	assert.equal(
		summaries(
			"GH_TOKEN=ghp_secret gh -R owner/repo pr edit 12 --body 'gh pr ready 99; secret body' --title 'Secret'",
		)[0]?.target,
		"PR #12",
	);
	assert.equal(summaries("gh pr create --head feat/a --body-file /tmp/private")[0]?.target, "branch feat/a");
	assert.equal(summaries("gh api repos/owner/repo/pulls/12 --method PATCH --input /tmp/private")[0]?.target, "PR #12");
	const audit = JSON.stringify(
		summaries("GH_TOKEN=ghp_secret gh api graphql -f 'query=mutation { secret }' -H 'Authorization: bearer private'"),
	);
	assert.equal(audit.includes("secret"), false);
	assert.equal(audit.includes("private"), false);
	assert.equal(summaries("gh pr create --head ghp_secret")[0]?.target, undefined);
	assert.equal(summaries("git push https://user:private@github.com/owner/repo feat/a")[0]?.target, "feat/a");
});
test("structured events expose branch, PR number and bounded literal title", () => {
	const [push] = summaries("jj git push --bookmark feat/events");
	assert.equal(push?.kind, "push");
	assert.equal(push?.branch, "feat/events");
	const [opened] = summaries("gh pr create --head feat/events --title 'Quiet chat events'");
	assert.equal(opened?.kind, "pr_opened");
	assert.equal(opened?.branch, "feat/events");
	assert.equal(opened?.title, "Quiet chat events");
	assert.equal(summaries("gh pr ready 441 --undo")[0]?.kind, "pr_draft");
	assert.equal(summaries("gh pr edit 441")[0]?.prNumber, 441);
	assert.equal(summaries("gh pr create --title '$PRIVATE'")[0]?.title, undefined);
	assert.equal(summaries("gh pr create --title '" + "a".repeat(500) + "'")[0]?.title?.length, 200);
});
test("reads, literal source and dry runs are not GitHub actions", () => {
	for (const command of [
		"gh pr view 12",
		"git status",
		"git push --dry-run",
		"gh pr ready --help",
		"gh api repos/owner/repo/pulls/12",
		"gh api graphql -f query='query { viewer { login } }' --method GET",
		"echo 'gh pr ready 12'",
		"printf '%s' 'git push origin secret'",
		"# gh pr ready 12",
		"echo done # comment; gh pr ready 12",
	]) {
		assert.deepEqual(summaries(command), [], command);
	}
	assert.deepEqual(
		githubCommandSummaries("codemode", { code: 'await tools.bash({command:"gh pr ready 12"})' }).summaries,
		[],
	);
	assert.deepEqual(githubCommandSummaries("write", { content: "git push origin private" }).summaries, []);
	assert.equal(githubCommandSummaries("bash", { command: "gh pr ready 12; echo done" }).single, false);
	assert.equal(summaries("git push origin feat/a && gh pr ready 12").length, 2);
	assert.deepEqual(summaries("gh api graphql -f query='query { viewer { login } }' -f owner=example"), []);
	assert.equal(
		summaries("gh api graphql -f query='mutation { updatePullRequest }' -f owner=example")[0]?.summary,
		"gh api mutation",
	);
	assert.equal(summaries("gh api -XPATCH repos/owner/repo/pulls/12")[0]?.target, "PR #12");
	assert.equal(summaries("gh pr ready --repo owner/repo 12")[0]?.target, "PR #12");
	assert.equal(summaries("gh pr create --body '--head' private")[0]?.target, undefined);
	assert.equal(summaries("gh pr create --body '--help'").length, 1);
});
test("failure and unknown status never claim success", () => {
	const action = { id: "a", summary: "gh pr ready", description: "marked PR #12 ready", at: 1, exitCode: 1 };
	assert.match(actionText(action), /attempted:.*failed, exit 1/);
	assert.match(actionText({ ...action, exitCode: null }), /attempted:.*unknown/);
	assert.doesNotMatch(actionText({ ...action, exitCode: 0 }), /attempted|failed|unknown/);
	assert.match(
		actionText({
			...action,
			exitCode: 0,
			publication: {
				attemptId: "original",
				stage: "unknown",
				evidence: "command-result",
				local: { status: "unknown" },
			},
		}),
		/attempted:.*unknown/,
	);
});
test("only a confirmed PR creation records its exact URL", async () => {
	const run = async (command: string, exitCode: number, output: string) => {
		const recorded: GitHubAction[] = [];
		const audit = githubActions(async (action) => {
			recorded.push(action);
		});
		const tool = {
			name: "bash",
			execute: async () => ({
				content: [{ type: "text", text: output }],
				details: { __piNativeAdapter: { structuredContent: { exit_code: exitCode, output } } },
			}),
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal synthetic extension and call context.
		const [wrapped] = audit.prepare({ tools: [tool] } as any).tools as any[];
		await wrapped.execute({ command }, { callId: "call-1" }, {});
		return recorded.filter((action) => action.publication?.evidence !== "command-dispatch");
	};
	const url = "https://github.com/acme/app/pull/42";
	const [opened] = await run("gh pr create --title 'Inline events'", 0, `${url}\n`);
	assert.equal(opened?.url, url);
	assert.equal(opened?.prNumber, 42);
	assert.equal((await run("gh pr create --title 'Inline events'", 1, `${url}\n`))[0]?.url, undefined);
	assert.equal((await run("gh pr create", 0, `See ${url} and more\n`))[0]?.url, undefined);
	assert.equal((await run("gh pr ready 42", 0, `${url}\n`))[0]?.url, undefined);
	assert.equal((await run("git push origin feat/a", 0, `${url}\n`))[0]?.url, undefined);
});
test("session audit is bounded, deduplicated and independent of conversation forks", async () => {
	const session = createSession(new MemoryStorage());
	try {
		await session.commit(async (tx) => {
			const state = await tx.doc(GitHubActionsDoc);
			for (let i = 0; i < 250; i++)
				appendGitHubAction(state, {
					id: String(i),
					summary: "git push",
					description: "pushed branches",
					at: i,
					exitCode: 0,
				});
			assert.equal(appendGitHubAction(state, state.actions.at(-1)!), false);
			await tx.createConversation({ ownership: { kind: "ownerless" } });
		}, context);
		const state = await session.snapshot(GitHubActionsDoc, context);
		assert.equal(state?.actions.length, 200);
		assert.equal(state?.actions[0]?.id, "50");
		assert.equal(state?.actions.at(-1)?.id, "249");
	} finally {
		await session.close(context);
	}
});

test("publication attempts commit before dispatch; command results never promote missing PR proof", async () => {
	for (const command of ["jj git push --bookmark feat/a", "gh pr create --head feat/a"]) {
		const recorded: GitHubAction[] = [];
		const local = {
			status: "owned" as const,
			repositoryId: "a".repeat(64),
			operationId: "b".repeat(128),
			revisions: [{ changeId: "k".repeat(32), commitId: "c".repeat(40), startCommitId: "d".repeat(40) }],
		};
		const audit = githubActions(
			async (action) => {
				recorded.push(action);
			},
			async () => local,
		);
		let executed = 0;
		const tool = {
			name: "bash",
			execute: async () => {
				assert.equal(recorded.length, 1);
				assert.equal(recorded[0]?.publication?.stage, "attempted");
				executed++;
				return { content: [], details: { __piNativeAdapter: { structuredContent: { exit_code: 0, output: "" } } } };
			},
		};
		const wrapped = audit.prepare({ tools: [tool] } as never).tools![0]!;
		await wrapped.execute({ command }, { callId: "publish" } as never, {} as never);
		assert.equal(executed, 1);
		assert.equal(recorded.length, 2);
		assert.equal(recorded[1]?.publication?.attemptId, recorded[0]?.id);
		assert.equal(recorded[1]?.publication?.stage, command.startsWith("jj") ? "confirmed" : "unknown");
		assert.deepEqual(recorded[1]?.publication?.local, command.startsWith("jj") ? local : { status: "unknown" });
	}
});

test("lost mutation replies remain Unknown and audit failure prevents dispatch", async () => {
	const records: GitHubAction[] = [];
	let calls = 0;
	const tool = {
		name: "bash",
		execute: async () => {
			calls++;
			throw new Error("lost reply");
		},
	};
	const audit = githubActions(async (action) => {
		records.push(action);
	});
	const wrapped = audit.prepare({ tools: [tool] } as never).tools![0]!;
	await assert.rejects(
		wrapped.execute({ command: "jj git push --bookmark feat/a" }, { callId: "lost" } as never, {} as never),
		/lost reply/,
	);
	assert.equal(calls, 1);
	assert.deepEqual(
		records.map((a) => a.publication?.stage),
		["attempted", "unknown"],
	);
	const blocked = githubActions(async () => {
		throw new Error("storage unavailable");
	});
	await assert.rejects(
		blocked
			.prepare({ tools: [tool] } as never)
			.tools![0]!.execute({ command: "gh pr create" }, { callId: "blocked" } as never, {} as never),
		/storage unavailable/,
	);
	assert.equal(calls, 1);
});

test("nested dispatch survives a missing result without inspecting codemode source", async () => {
	const records: GitHubAction[] = [];
	const audit = githubActions(async (action) => {
		records.push(action);
	});
	const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
	audit.native({
		on: (event: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(event, handler),
	} as never);
	const tool = {
		name: "codemode",
		execute: async () => {
			await handlers.get("tool_call")!({
				toolCallId: "outer/1",
				toolName: "bash",
				input: { command: "gh pr create" },
			});
			throw new Error("worker lost before result");
		},
	};
	await assert.rejects(
		audit
			.prepare({ tools: [tool] } as never)
			.tools![0]!.execute({ code: "irrelevant source" }, { callId: "outer" } as never, {} as never),
		/worker lost/,
	);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.publication?.stage, "attempted");
	assert.equal(records[0]?.toolCallId, "outer");
	assert.equal(records[0]?.id, "outer/1:0:attempt");
});
