// Test-only: the screen agent's bar over a few controls, with a scripted conversation. Every word is invented.
import { mount, signal, View } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { ScreenAgentBar } from "./ScreenAgentBar";
import type { ScreenAgentSource } from "./screenAgent";
import type { ScreenPicture } from "./screenAgentContract";
import type { SessionChat } from "./sessionChat";
import { Block, Button, Caption, Notice, WindowCanvas } from "./ui";

/** What the scripted agent heard, for the test to read. */
export const heard = signal<string[]>([]);
export const feedbackSent = signal("");

const row = (key: string, role: ChatRow["role"], text: string): ChatRow => ({
	key,
	role,
	text,
	shortened: false,
	running: false,
	failed: false,
});

class ScriptedScreenAgent implements ScreenAgentSource {
	#chat: SessionChat | null = null;
	#listeners = new Set<(chat: SessionChat | null) => void>();
	chat() {
		return this.#chat;
	}
	onChange(listener: (chat: SessionChat | null) => void) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async ask(message: string) {
		heard.set([...heard(), message]);
		const rows = [...(this.#chat?.rows ?? [])];
		const n = rows.length;
		rows.push(row(`${n}`, "you", message));
		rows.push(row(`${n + 1}`, "step", "Read this window"));
		rows.push(
			row(
				`${n + 2}`,
				"pilot",
				message.startsWith("Write feedback")
					? '{"text": "New 4 reads as a wrong count."}'
					: "New counts the items it shows.",
			),
		);
		this.#chat = {
			sessionId: "s",
			title: "Screen agent",
			state: "idle",
			stateReason: "",
			rows,
			more: false,
			reading: false,
			reason: "",
		};
		for (const l of this.#listeners) l(this.#chat);
		return "";
	}
	async picture(): Promise<ScreenPicture | null> {
		return {
			attachment: { uploadId: "u", sha256: "a".repeat(64), bytes: 10 },
			width: 10,
			height: 10,
			mimeType: "image/png",
		};
	}
	async sendFeedback(text: string) {
		feedbackSent.set(text);
		return {
			ok: true,
			message: "Feedback saved. This conversation is its triage now. Your next question starts a new conversation.",
		};
	}
	dispose() {}
}

// One source for the window: JSX props are read again on each access.
const source = new ScriptedScreenAgent();

mount(() => (
	<WindowCanvas>
		<Block>
			<View class="flex-row">
				<Button label="Save" onPress={() => {}} />
			</View>
			<Caption testID="heard">{`heard ${heard().length}`}</Caption>
			<Caption testID="last-heard">{heard().at(-1) ?? ""}</Caption>
			<Notice text="New 4" />
		</Block>
		<ScreenAgentBar source={source} />
	</WindowCanvas>
));
