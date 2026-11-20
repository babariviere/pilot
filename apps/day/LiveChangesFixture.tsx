import { type JSX, mount, signal, View } from "nsh";
import { ChatScreen } from "./ChatScreen";
import { openDay, openMockChat } from "./mockFeeds";
import { type LiveChangesResult, mirrorSessionChat, type SessionChat } from "./sessionChat";
import { Block, Button, Buttons, Caption, GridBackdrop } from "./ui";

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

// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => (
	<FixtureWindow>
		<Block>
			<Buttons>
				<Button small label="Replace workspace" onPress={() => key.set("second")} />
				<Button small label="Workspace lost" onPress={() => key.set(undefined)} />
				<Button
					small
					label="Finish empty"
					onPress={() => pending.shift()?.({ status: "read", fileCount: 0, patch: "", truncated: false })}
				/>
				<Button small label="Finish stale" onPress={() => pending.shift()?.({ status: "stale" })} />
				<Button small label="Finish unavailable" onPress={() => pending.shift()?.({ status: "unavailable" })} />
				<Button
					small
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
			</Buttons>
			<Caption>{`Reads: ${reads().join(", ") || "none"}`}</Caption>
		</Block>
		<View class="min-h-0 flex-1">
			<ChatScreen
				day={{
					...day,
					chat: { ...chat, chat: Object.assign(shown, { set: chat.chat.set, update: chat.chat.update }) },
				}}
				sessionId="test-chat"
			/>
		</View>
	</FixtureWindow>
));
