import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpServerStatus, McpStatus } from "@pilot/protocol";
import { McpChatAttention, type McpStatusSource } from "./mcp-attention.ts";
import { sessionNeedsYouReason } from "./needs-you-reason.ts";

function source(servers: McpServerStatus[]) {
	let status: McpStatus = { servers, checking: false };
	const listeners = new Set<(status: McpStatus) => void>();
	const checks: Array<string | undefined> = [];
	const mcp: McpStatusSource = {
		status: () => status,
		check: (server) => {
			checks.push(server);
		},
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		mcp,
		checks,
		publish(next: McpServerStatus[]) {
			status = { servers: next, checking: false };
			for (const listener of listeners) listener(status);
		},
	};
}

const signedOut: McpServerStatus = { name: "data-dog", transport: "http", state: "needs_sign_in", canSignIn: true };
const local: McpServerStatus = {
	name: "local",
	transport: "stdio",
	state: "failed",
	problem: "Couldn't start the server.",
};
const linear: McpServerStatus = { name: "linear", transport: "http", state: "connected", tools: 4, checkedAt: 1 };

test("a chat that reaches for a server needing the user asks for it until the server works again", () => {
	const fake = source([signedOut, local, linear]);
	const changed: string[] = [];
	const attention = new McpChatAttention(fake.mcp, (id) => changed.push(id));

	attention.report("chat", ["linear", "unknown"], false);
	assert.equal(attention.attention("chat"), undefined, "working and unknown servers never ask");
	attention.report("chat", ["data_dog"], false);
	const first = attention.attention("chat")!;
	assert.deepEqual(first.attentionReason, { kind: "mcp", detail: "data-dog needs sign-in", server: "data-dog" });
	attention.report("chat", ["local", "data_dog"], true);
	assert.deepEqual(attention.attention("chat")?.attentionReason, {
		kind: "mcp",
		detail: "data-dog needs sign-in (+1)",
		server: "data-dog",
	});
	assert.equal(attention.attention("chat")?.attentionAt, first.attentionAt);
	assert.deepEqual(changed, ["chat", "chat"]);

	fake.publish([{ ...signedOut, state: "connected", tools: 3 }, local, linear]);
	assert.deepEqual(attention.attention("chat")?.attentionReason, {
		kind: "mcp",
		detail: "local isn't connecting",
		server: "local",
	});
	fake.publish([linear]);
	assert.equal(attention.attention("chat"), undefined, "servers removed from mcp.json release the chat");
	assert.deepEqual(changed, ["chat", "chat", "chat", "chat"]);
	attention.close();
});

test("a failed call to a server last seen connected rechecks it before asking", () => {
	const fake = source([linear]);
	const changed: string[] = [];
	const attention = new McpChatAttention(fake.mcp, (id) => changed.push(id));
	attention.report("chat", ["linear"], false);
	assert.deepEqual(fake.checks, [], "successful use never rechecks");
	attention.report("chat", ["linear"], true);
	attention.report("other", ["linear"], true);
	assert.deepEqual(fake.checks, ["linear", "linear"]);
	assert.equal(attention.attention("chat"), undefined);

	fake.publish([{ ...linear, checkedAt: 0, state: "needs_sign_in" }]);
	assert.equal(attention.attention("chat"), undefined, "a result older than the failed call decides nothing");
	fake.publish([{ ...linear, checkedAt: Date.now() + 1, state: "needs_sign_in" }]);
	assert.equal(attention.attention("chat")?.attentionReason.detail, "linear needs sign-in");
	assert.equal(attention.attention("other")?.attentionReason.detail, "linear needs sign-in");

	attention.clear("chat");
	assert.equal(attention.attention("chat"), undefined, "writing in the chat or archiving it clears it");
	assert.deepEqual(changed.sort(), ["chat", "chat", "other"]);

	attention.report("third", ["linear"], true);
	fake.publish([{ ...linear, checkedAt: Date.now() + 2 }]);
	assert.equal(attention.attention("third"), undefined, "a recheck that finds it connected asks nothing");
	attention.close();
});

test("MCP attention outranks the chat's outcome until the server works", () => {
	const attentionReason = { kind: "mcp" as const, detail: "datadog needs sign-in", server: "datadog" };
	const chat = {
		id: "chat",
		title: "Logs",
		cwd: "/tmp",
		createdAt: 1,
		updatedAt: 2,
		state: "parked" as const,
		outcome: "failed" as const,
		outcomeReason: "Couldn't read logs",
	};
	assert.deepEqual(sessionNeedsYouReason({ ...chat, attentionReason }), attentionReason);
	assert.equal(sessionNeedsYouReason(chat).kind, "failed");
});
