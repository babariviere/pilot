// Invented service data. Uses the real chat, navigation and result views.
import { mount, signal, View } from "nsh";
import { DayScreen } from "./app/DayScreen";
import { mockRituals, openDay } from "./app/testing/mockFeeds";
import { type DeliveredWork, mirrorDelivery } from "./missions/delivery/deliveryFeed";
import { ScriptedDelivery } from "./missions/delivery/deliveryDemo";
import { openChat } from "./sessions/chatView";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessions/sessionChat";
import { Feed } from "./sources/source";
import { Block, Caption } from "./ui";

const projectId = "mock-project";
const sessionId = "csv-build";
const title = "Keep the CSV import fast";
const result: DeliveredWork = {
	version: 1,
	subject: { kind: "chat", projectId, sessionId },
	targetId: "standalone-result",
	ownerSessionId: sessionId,
	deliveryId: "a".repeat(64),
	title,
	outcome: { outcomeAt: 4 },
	pullRequests: [],
	artifacts: [],
	production: "not_tracked",
	verification: null,
	verificationCurrent: false,
	verificationReceiptState: "unknown",
	verificationRevision: 0,
	pendingOperationId: null,
};
const delivery = new ScriptedDelivery([result]);
const sends = signal(0);
const active = signal<SessionChat | null>(null);
const feed = new Feed(active);
const chat: SessionChatSource = {
	chat: active,
	onChange: (listener) => feed.onChange(listener),
	async open(id) {
		active.set({
			sessionId: id,
			projectId,
			title,
			state: "done",
			stateReason: "",
			canCheckResult: true,
			canReply: true,
			rows: [],
			more: false,
			reading: false,
			reason: "",
		});
		feed.publish();
	},
	close() {
		active.set(null);
		feed.publish();
	},
	async earlier() {},
	async refresh() {},
	async continueChat() {
		return { status: "rejected", message: "" };
	},
	async checkContinue() {
		return { status: "rejected", message: "" };
	},
	async replyChat() {
		sends.update((n) => n + 1);
		return { status: "accepted", message: "" };
	},
	dispose() {},
};
const day = { ...openDay(), chat: mirrorSessionChat(chat), delivery: mirrorDelivery(delivery) };
day.today.set({ ...day.today(), project: projectId });
openChat(sessionId, "Today");
mount(() => (
	<View class="flex-1">
		<DayScreen day={day} rituals={mockRituals(day)} />
		<Block>
			<Caption>{`Chat sends: ${sends()} · Result writes: ${delivery.counts().sends}`}</Caption>
		</Block>
	</View>
));
