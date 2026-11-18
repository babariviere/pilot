// Fixture data only. An explorer chat whose question the plan settled: the page does not say it waits.
import { mount } from "nsh";
import { ChatScreen } from "./ChatScreen";
import { openDay, openMockChat } from "./mockFeeds";
import { mirrorSessionChat, type SessionChat } from "./sessionChat";

const source = openMockChat().source;
const settled = (chat: SessionChat | null): SessionChat | null =>
	chat ? { ...chat, title: "Research: Verify the event schema", state: "question", questionSettled: true } : null;
const chat = mirrorSessionChat({
	chat: () => settled(source.chat()),
	onChange: (listener) => source.onChange((value) => listener(settled(value))),
	open: (id) => source.open(id),
	earlier: () => source.earlier(),
	refresh: () => source.refresh(),
	close: (id) => source.close(id),
	dispose: () => source.dispose(),
	continueChat: (id) => source.continueChat(id),
	checkContinue: (id) => source.checkContinue(id),
});
mount(() => <ChatScreen day={{ ...openDay(), chat }} sessionId="research-old" />);
