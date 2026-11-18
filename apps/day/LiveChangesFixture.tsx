import { mount, signal, Text, View } from "nsh";
import { ChatScreen } from "./ChatScreen";
import { openDay, openMockChat } from "./mockFeeds";
import { type LiveChangesResult, mirrorSessionChat, type SessionChat } from "./sessionChat";
import { Action } from "./ui";

const source = openMockChat().source;
const key = signal<string | undefined>("first");
const reads = signal<string[]>([]);
const pending: Array<(value: LiveChangesResult) => void> = [];
const chat = mirrorSessionChat({
	chat: () => source.chat(),
	onChange: (listener) => source.onChange(listener),
	open: (id) => source.open(id),
	earlier: () => source.earlier(),
	refresh: () => source.refresh(),
	close: (id) => source.close(id),
	dispose: () => source.dispose(),
	continueChat: (id) => source.continueChat(id),
	checkContinue: (id) => source.checkContinue(id),
	readLiveChanges: (session, workspace) => {
		reads.set([...reads(), `${session}/${workspace}`]);
		return new Promise((resolve) => pending.push(resolve));
	},
});
const shown = (): SessionChat | null => {
	const current = chat.chat();
	return current && { ...current, liveChangesKey: key() };
};
const day = openDay();

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap">
			<Action label="Replace workspace" onPress={() => key.set("second")} />
			<Action label="Workspace lost" onPress={() => key.set(undefined)} />
			<Action
				label="Finish empty"
				onPress={() => pending.shift()?.({ status: "read", fileCount: 0, patch: "", truncated: false })}
			/>
			<Action label="Finish stale" onPress={() => pending.shift()?.({ status: "stale" })} />
			<Action label="Finish unavailable" onPress={() => pending.shift()?.({ status: "unavailable" })} />
			<Action
				label="Finish clipped"
				onPress={() =>
					pending.shift()?.({
						status: "read",
						fileCount: 2,
						patch: "diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new\n",
						truncated: true,
					})
				}
			/>
		</View>
		<Text>{`Reads: ${reads().join(", ") || "none"}`}</Text>
		<ChatScreen
			day={{
				...day,
				chat: { ...chat, chat: Object.assign(shown, { set: chat.chat.set, update: chat.chat.update }) },
			}}
			sessionId="test-chat"
		/>
	</View>
));
