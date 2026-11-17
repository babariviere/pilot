// One request's original agent context. Reading starts no agent and creates no thread or notification.
import { cleanup, Scroll, Text, View } from "nsh";
import { ChatTranscript } from "./ChatRows";
import type { SessionChatMirror } from "./sessionChat";

export function QuestionDiscussion(props: { mirror: SessionChatMirror; sessionId: string }) {
	const sessionId = props.sessionId;
	void props.mirror.source.open(sessionId);
	cleanup(() => props.mirror.source.close(sessionId));
	const chat = () => {
		const read = props.mirror.chat();
		// Limit the nonvirtualized preview to 16 rows; original history is neither trimmed nor rewritten.
		return read?.sessionId === sessionId ? { ...read, rows: read.rows.slice(-16), more: false } : null;
	};
	return (
		<View testID="question-discussion" class="gap-2">
			<Text class="text-sm font-medium text-foreground">Discussion with the asking agent</Text>
			<Text class="text-xs text-muted-foreground">
				Same request, same agent. Ask a question to clarify, or use the reply below to answer. Opening this starts
				nothing.
			</Text>
			<Text class="text-xs text-muted-foreground">Recent context, up to 16 entries</Text>
			<Scroll class="h-64 rounded-lg border border-border p-3">
				<ChatTranscript
					id="question-context"
					chat={chat()}
					readingWords="Reading the original conversation…"
					emptyWords="No conversation entries available."
					onEarlier={() => {}}
				/>
			</Scroll>
		</View>
	);
}
