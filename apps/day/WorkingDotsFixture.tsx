// Scripted turns in the real chat screen and Screen Agent bar. No service or provider.
import { keymap, mount } from "nsh";
import type { Day } from "./app/day";
import { ScreenAgentBar } from "./screen-agent/ScreenAgentBar";
import type { ScreenAgentSource } from "./screen-agent/screenAgent";
import { ChatScreen } from "./sessions/ChatScreen";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessions/sessionChat";
import { WindowCanvas } from "./ui";

let chat: SessionChat = {
	sessionId: "fixture-chat",
	title: "Export preview",
	state: "working",
	stateReason: "",
	canReply: true,
	rows: [
		{ key: "1", role: "you", text: "Check the export preview.", running: false, failed: false, shortened: false },
	],
	more: false,
	reading: false,
	reason: "",
};
let agentChat: SessionChat = {
	...chat,
	sessionId: "fixture-agent",
	title: "Screen agent",
	rows: [{ key: "2", role: "step", text: "Read this window", running: true, failed: false, shortened: false }],
};
let publishChat: (value: SessionChat) => void;
let publishAgent: (value: SessionChat) => void;
const source: SessionChatSource = {
	chat: () => chat,
	onChange(fn) {
		publishChat = fn;
		return () => {};
	},
	async open() {},
	async earlier() {},
	async refresh() {},
	close() {},
	dispose() {},
	async continueChat() {
		throw new Error("Unexpected Continue");
	},
	async replyChat() {
		throw new Error("Unexpected reply");
	},
	async checkContinue() {
		throw new Error("Unexpected Check");
	},
};
const agent: ScreenAgentSource = {
	chat: () => agentChat,
	onChange(fn) {
		publishAgent = fn;
		return () => {};
	},
	async ask() {
		throw new Error("Unexpected Ask");
	},
	async picture() {
		return null;
	},
	async sendFeedback() {
		throw new Error("Unexpected feedback");
	},
	dispose() {},
};
const day = { chat: mirrorSessionChat(source) } as Day;

mount(() => {
	keymap.bind(
		"mod+shift+w",
		() => {
			chat = { ...chat, state: "done" };
			agentChat = { ...agentChat, state: "done", rows: [] };
			publishChat(chat);
			publishAgent(agentChat);
		},
		{ when: "always" },
	);
	return (
		<WindowCanvas>
			<ChatScreen day={day} sessionId={chat.sessionId} />
			<ScreenAgentBar source={agent} />
		</WindowCanvas>
	);
});
