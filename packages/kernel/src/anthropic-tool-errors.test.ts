import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicToolErrors } from "./anthropic-tool-errors.ts";

const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const text = (text: string) => ({ type: "text", text });

test("failed tool images move after all tool results without mutating history or losing error/cache metadata", () => {
	const first = image("first"),
		second = image("second");
	const successful = { type: "tool_result", tool_use_id: "success", is_error: false, content: [image("success")] };
	const failed = {
		type: "tool_result",
		tool_use_id: "failed",
		is_error: true,
		content: [text("Partial output"), first, text("Missing file"), second],
		cache_control: { type: "ephemeral" },
	};
	const payload = {
		model: "offline",
		messages: [
			{ role: "assistant", content: [text("Calling tools")] },
			{ role: "user", content: [failed, successful, text("Following input")] },
		],
	};
	const before = structuredClone(payload);
	const result = anthropicToolErrors(payload, "anthropic-messages") as typeof payload;
	assert.deepEqual(payload, before);
	assert.notEqual(result, payload);
	assert.equal(result.messages[0], payload.messages[0]);
	const blocks = result.messages[1]!.content;
	assert.deepEqual(blocks, [
		{
			...failed,
			content: [
				text("Partial output"),
				text("[Image from this failed tool result is attached below.]"),
				text("Missing file"),
				text("[Image from this failed tool result is attached below.]"),
			],
		},
		successful,
		text("Following input"),
		first,
		second,
	]);
	assert.equal(blocks[1], successful);
	assert.equal(blocks[3], first);
	assert.equal(anthropicToolErrors(result, "anthropic-messages"), result, "repair is idempotent");
});

test("multiple failed tools retain batch order and images even when there is no error text", () => {
	const images = [image("one"), image("two")];
	const payload = {
		messages: [
			{
				role: "user",
				content: images.map((img, i) => ({
					type: "tool_result",
					tool_use_id: String(i),
					is_error: true,
					content: [img],
				})),
			},
		],
	};
	const result = anthropicToolErrors(payload, "anthropic-messages") as typeof payload;
	const content = result.messages[0]!.content;
	assert.deepEqual(content.slice(2), images);
	assert.deepEqual(
		content.slice(0, 2).map((block) => block.tool_use_id),
		["0", "1"],
	);
});

test("other APIs, ordinary images, text errors and opaque hook payloads are unchanged", () => {
	const mixed = {
		messages: [{ role: "user", content: [{ type: "tool_result", is_error: true, content: [image("x")] }] }],
	};
	assert.equal(anthropicToolErrors(mixed, "openai-responses"), mixed);
	for (const payload of [
		undefined,
		null,
		"opaque",
		{},
		{ messages: "opaque" },
		{
			messages: [
				{ role: "user", content: [image("x"), { type: "tool_result", is_error: false, content: [image("x")] }] },
			],
		},
		{ messages: [{ role: "user", content: [{ type: "tool_result", is_error: true, content: [text("Failed")] }] }] },
		{ messages: [{ role: "user", content: [{ type: "tool_result", is_error: true, content: "Failed" }] }] },
	])
		assert.equal(anthropicToolErrors(payload, "anthropic-messages"), payload);
});
