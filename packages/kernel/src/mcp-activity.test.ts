import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpActivity, mcpNamespaces } from "./mcp-activity.ts";

test("MCP namespaces come from codemode scripts and direct MCP tools, never other tools", () => {
	assert.deepEqual(
		mcpNamespaces("codemode", {
			code: "await tools.mcp__datadog__search_logs({});\nawait tools.mcp__stoik_data__CALL_TOOL({});\ntools.mcp__datadog__x()",
		}),
		["datadog", "stoik_data"],
	);
	assert.deepEqual(mcpNamespaces("codemode", { code: 'await describeNamespace("mcp__linear")' }), ["linear"]);
	assert.deepEqual(mcpNamespaces("mcp__sentry__list_issues", {}), ["sentry"]);
	assert.deepEqual(mcpNamespaces("bash", { command: "echo mcp__datadog__x" }), []);
	assert.deepEqual(mcpNamespaces("codemode", { code: 42 }), []);
});

test("MCP activity reports top-level calls once a minute per namespace and outcome", () => {
	const reports: Array<[string[], boolean]> = [];
	let handler: ((event: Record<string, unknown>) => void) | undefined;
	mcpActivity((namespaces, failed) => reports.push([namespaces, failed]))({
		on: (name: string, listener: (event: Record<string, unknown>) => void) => {
			if (name === "tool_result") handler = listener;
		},
	} as never);
	const call = (code: string, isError: boolean, parentToolCallId?: string) =>
		handler!({ toolName: "codemode", input: { code }, isError, ...(parentToolCallId ? { parentToolCallId } : {}) });
	call("tools.mcp__datadog__a()", true);
	call("tools.mcp__datadog__a()", true);
	call("tools.mcp__datadog__a(); tools.mcp__linear__b()", false);
	call("tools.mcp__notion__a()", true, "parent");
	assert.deepEqual(reports, [
		[["datadog"], true],
		[["datadog", "linear"], false],
	]);
});
