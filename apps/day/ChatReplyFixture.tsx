import { keymap, mount } from "nsh";
import { ChatScreen } from "./ChatScreen";
import type { Day } from "./day";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessionChat";
import { WindowCanvas } from "./ui";

const chat: SessionChat = {
	sessionId: "export-test",
	title: "Export preview",
	state: "stopped",
	stateReason: "Stopped at your request.",
	canReply: true,
	rows: [
		{ key: "1", role: "you", text: "Check what happens to the header when I export filtered rows." },
		{ key: "2", role: "step", text: "Read files" },
		{ key: "3", role: "step", text: "Searched files" },
		{ key: "4", role: "step", text: "Ran a command" },
		{ key: "5", role: "pilot", text: "The export keeps the header even if the filter returns no rows." },
	].map((row) => ({ ...row, running: false, failed: false, shortened: false })) as SessionChat["rows"],
	more: false,
	reading: false,
	reason: "",
};
let replyWords = "";
let unknown = false;
let listener: (value: SessionChat) => void;
const source: SessionChatSource = {
	chat: () => chat,
	onChange(fn) {
		listener = fn;
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
	async replyChat(_id, words) {
		replyWords = words;
		if (unknown) return { status: "unknown", message: "Unconfirmed.", operationId: "test-reply" };
		add(words);
		return { status: "accepted", message: "" };
	},
	async checkContinue() {
		if (unknown) return { status: "unknown", message: "Unconfirmed.", operationId: "test-reply" };
		add(replyWords);
		return { status: "accepted", message: "", submittedText: replyWords, operationId: "test-reply" };
	},
};
function add(text: string) {
	chat.rows = [
		...chat.rows,
		{ key: String(chat.rows.length + 1), text, role: "you", running: false, failed: false, shortened: false },
	];
	listener({ ...chat });
}
const day = { chat: mirrorSessionChat(source) } as Day;
mount(() => {
	keymap.bind("mod+shift+u", () => add("An update from the service."), { when: "always" });
	keymap.bind(
		"mod+shift+l",
		() => {
			unknown = !unknown;
		},
		{ when: "always" },
	);
	return (
		<WindowCanvas>
			<ChatScreen day={day} sessionId={chat.sessionId} />
		</WindowCanvas>
	);
});
