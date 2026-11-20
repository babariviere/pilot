// Fixture data only. The real read-only chat screen renders a service queue reason.
import { mount } from "nsh";
import { openDay, openMockChat } from "./app/testing/mockFeeds";
import { ChatScreen } from "./sessions/ChatScreen";
import { mirrorSessionChat, type SessionChat } from "./sessions/sessionChat";

const source = openMockChat().source;
const queued = (chat: SessionChat | null): SessionChat | null =>
	chat
		? {
				...chat,
				title: "Queued coding work",
				state: "idle",
				stateReason: "Waiting for a Pilot coding slot (4 of 4 occupied).",
				queue: { kind: "slots", position: 2, holders: ["Search index", "Export tests", "Docs pass"] },
			}
		: null;
const chat = mirrorSessionChat({
	chat: () => queued(source.chat()),
	onChange: (listener) => source.onChange((value) => listener(queued(value))),
	open: (id) => source.open(id),
	earlier: () => source.earlier(),
	refresh: () => source.refresh(),
	close: (id) => source.close(id),
	dispose: () => source.dispose(),
	continueChat: (id) => source.continueChat(id),
	checkContinue: (id) => source.checkContinue(id),
});
mount(() => <ChatScreen day={{ ...openDay(), chat }} sessionId="queued" />);
