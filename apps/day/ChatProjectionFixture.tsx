// Test-only native-channel projection. The test supplies all host replies.
import { mount, signal } from "nsh";
import { ConnectedSessionChat, mirrorSessionChat, type SessionChat } from "./sessionChat";
// Parts come file by file, not from "./ui": this fixture loads as its own app (fixtures/recovery/Projection.tsx),
// and the library's index imports font and icon files that sit outside that app's folder.
import { Button } from "./ui/button";
import { WindowCanvas } from "./ui/canvas";
import { Block } from "./ui/section";
import { Body } from "./ui/text";

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
		<WindowCanvas>
			<Block>
				<Button label="Read earlier" onPress={() => void source.earlier()} />
				<Body>{metadata(mirror.chat())}</Body>
				<Body>{`Loading: ${loading()}`}</Body>
				<Body>{mirror.chat()?.reason ?? ""}</Body>
			</Block>
		</WindowCanvas>
	);
});
