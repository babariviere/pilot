// Headless fixture only. No daemon, worker, provider or storage.
// A task result page whose chat delivered nothing yet: it shows where the
// chat is and the one action that moves it. Continue goes to a script that
// counts it and sets the chat working, as the next read would.
import { mount, signal, Text, View } from "nsh";
import { chatRoute } from "./chatView";
import { DeliveryScreen } from "./DeliveryScreen";
import { ScriptedDelivery } from "./deliveryDemo";
import { type DeliveredWork, deliveryKey, mirrorDelivery, type VerificationSubject } from "./deliveryFeed";
import { openDay, openMockChat } from "./mockFeeds";
import { mirrorSessionChat, type SessionChatSource } from "./sessionChat";
import { Action } from "./ui";

const subject: VerificationSubject = { kind: "task", projectId: "p", missionId: "m", taskId: "t" };
const key = deliveryKey(subject);
const source = new ScriptedDelivery([]);
await source.readSaved();
const continues = signal(0);
const replies = signal<string[]>([]);
const setChat = (chat: DeliveredWork["chat"]) => {
	source.works.set(key, {
		version: 1,
		subject,
		deliveryId: null,
		targetId: "target",
		ownerSessionId: "worker-1",
		...(chat ? { chat } : {}),
		pullRequests: [],
		artifacts: [],
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
	});
	source.publish();
};
setChat({ state: "failed", reason: "Model request (anthropic): Allowance hold", canContinue: true });
const base = openMockChat().source;
const chat: SessionChatSource = {
	chat: () => base.chat(),
	onChange: (l) => base.onChange(l),
	open: (id) => base.open(id),
	earlier: () => base.earlier(),
	refresh: () => base.refresh(),
	close: (id) => base.close(id),
	checkContinue: (id) => base.checkContinue(id),
	dispose: () => base.dispose(),
	async continueChat() {
		continues.update((n) => n + 1);
		setChat({ state: "working" });
		return { status: "accepted", message: "", operationId: "c1" };
	},
	async replyChat(_sessionId, message) {
		replies.update((r) => [...r, message]);
		return { status: "accepted", message: "", operationId: "r1" };
	},
};
const day = { ...openDay(), delivery: mirrorDelivery(source), chat: mirrorSessionChat(chat) };

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-1">
			<DeliveryScreen day={day} place={{ key, subject, title: "Export the audit log" }} />
		</View>
		<View class="flex-row flex-wrap gap-2 border-t border-border px-6 py-2">
			<Action label="Working" onPress={() => setChat({ state: "working" })} />
			<Action
				label="Queued"
				onPress={() => setChat({ state: "queued", reason: "Waiting for a Pilot coding slot (4 of 4 occupied)." })}
			/>
			<Action label="Asking" onPress={() => setChat({ state: "question" })} />
			<Action label="Stopped" onPress={() => setChat({ state: "stopped", canContinue: true })} />
			<Action label="Failed for good" onPress={() => setChat({ state: "failed", reason: "Startup failed" })} />
			<Action
				label="Waiting"
				onPress={() =>
					setChat({
						state: "waiting",
						canContinue: true,
						says: "Here is the mockup. Does the layout work for you?",
					})
				}
			/>
			<Text testID="counts">{`Continues: ${continues()} · Chat open: ${chatRoute()?.sessionId ?? "none"}`}</Text>
			<Text testID="replies">{`Replies: ${replies().join(" | ") || "none"}`}</Text>
		</View>
	</View>
));
