// Test-only native-channel projection. The test supplies all host replies.
import { mount, signal, Text, View } from "nsh";
// This fixture also loads as its own app (fixtures/recovery/Projection.tsx), where the parts in ./ui cannot load:
// ui/fonts.ts imports font files outside that app's directory. So it keeps the base Button and plain Text.
import { Button } from "nsh/base";
import { ConnectedSessionChat, mirrorSessionChat, type SessionChat } from "./sessionChat";

const source = new ConnectedSessionChat("projection-test");
const mirror = mirrorSessionChat(source);
const metadata = (c: SessionChat | null) =>
	`Custody: ${c?.workspaceKept} / Archived: ${c?.archived} / Startup: ${c?.restartOnly} / Pending: ${c?.pendingRecovery?.operationId}`;
const loading = signal("");
source.onChange((c) => {
	if (c?.reading) loading.set(metadata(c));
});
mount(() => {
	void source.open("chat-1");
	return (
		<View class="flex-1 bg-background">
			<Button onPress={() => void source.earlier()} class="p-3">
				<Text>Read earlier</Text>
			</Button>
			<Text>{metadata(mirror.chat())}</Text>
			<Text>{`Loading: ${loading()}`}</Text>
			<Text>{mirror.chat()?.reason ?? ""}</Text>
		</View>
	);
});
