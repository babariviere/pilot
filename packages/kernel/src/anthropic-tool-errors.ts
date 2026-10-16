function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Anthropic requires failed tool results to contain text only. Codemode can emit images before
 * failing, so keep those images as ordinary user attachments after the complete tool-result batch.
 * This is a wire-only repair, including for old chats: never rewrite history or replay the tool.
 */
export function anthropicToolErrors(payload: unknown, api: string): unknown {
	if (api !== "anthropic-messages" || !object(payload) || !Array.isArray(payload.messages)) return payload;
	let changed = false;
	const messages = payload.messages.map((message: unknown) => {
		if (!object(message) || message.role !== "user" || !Array.isArray(message.content)) return message;
		const images: unknown[] = [];
		const content = message.content.map((block: unknown) => {
			if (!object(block) || block.type !== "tool_result" || block.is_error !== true || !Array.isArray(block.content))
				return block;
			let moved = false;
			const parts = block.content.map((part: unknown) => {
				if (!object(part) || part.type !== "image") return part;
				moved = true;
				images.push(part);
				return { type: "text", text: "[Image from this failed tool result is attached below.]" };
			});
			return moved ? { ...block, content: parts } : block;
		});
		if (!images.length) return message;
		changed = true;
		return { ...message, content: [...content, ...images] };
	});
	return changed ? { ...payload, messages } : payload;
}
