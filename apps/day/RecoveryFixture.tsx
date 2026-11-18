// Synthetic recovery UI only. No daemon, credentials, processes or filesystem.
import { mount, signal, Text, View } from "nsh";
import { ChatScreen } from "./ChatScreen";
import type { Day } from "./day";
import { restoreRecoveryNotes, savedRecoveryNotes } from "./recoveryDraft";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessionChat";
import { Action } from "./ui";

const sends = signal(0);
const checks = signal(0);
const last = signal("");
const lost = signal(false);
const shown = signal(true);
const chat = signal<SessionChat | null>(null);
const listeners = new Set<(v: SessionChat | null) => void>();
const publish = (v: SessionChat | null) => {
	chat.set(v);
	for (const l of listeners) l(v);
};
const failed = (): SessionChat => ({
	sessionId: "recovery-chat",
	title: "Fix invoice export",
	state: "failed",
	stateReason: "Provider unavailable",
	sourceLabel: "Private coding copy",
	sourcePath: "/example/private/workspace",
	rows: [],
	more: false,
	reading: false,
	reason: "",
	workspaceKept: true,
});
const source: SessionChatSource = {
	chat,
	onChange(l) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	async open() {
		publish({ ...failed(), pendingRecovery: chat()?.pendingRecovery });
	},
	async earlier() {},
	async refresh() {},
	close() {},
	dispose() {},
	async continueChat() {
		return { status: "rejected", message: "Not stopped" };
	},
	async recoverChat(_id, message) {
		sends.update((n) => n + 1);
		last.set(message);
		if (lost()) {
			const pending = {
				status: "unknown" as const,
				operationId: "recover-1",
				message: "Not confirmed. Check only.",
				submittedText: message,
			};
			publish({ ...failed(), pendingRecovery: pending });
			return pending;
		}
		publish({ ...failed(), state: "working" });
		return { status: "accepted", message: "", operationId: "recover-1" };
	},
	async checkContinue() {
		checks.update((n) => n + 1);
		publish({ ...failed(), state: "working" });
		return { status: "accepted", message: "", operationId: "recover-1" };
	},
};
const day = { chat: mirrorSessionChat(source) } as Day;
mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row flex-wrap gap-3 p-3">
			<Text>Mock data</Text>
			<Action label="Hide chat" onPress={() => shown.set(false)} />
			<Action label="Reopen chat" onPress={() => shown.set(true)} />
			<Action label="Lose next answer" onPress={() => lost.set(true)} />
			<Action label="Fail again" onPress={() => publish(failed())} />
			<Action label="Startup failure" onPress={() => publish({ ...failed(), restartOnly: true })} />
			<Action
				label="Setup failed"
				onPress={() =>
					publish({ ...failed(), recoveryBlocked: "Repair setup before retrying. Existing files are kept." })
				}
			/>
			<Action label="Archive view" onPress={() => publish({ ...failed(), archived: true })} />
			<Action
				label="Save and reopen"
				onPress={() => {
					const kept = savedRecoveryNotes();
					shown.set(false);
					restoreRecoveryNotes([]);
					restoreRecoveryNotes(kept);
					shown.set(true);
				}}
			/>
			<Text>{`Sends: ${sends()} / Checks: ${checks()}`}</Text>
			<Text>{`Sent: [${last()}]`}</Text>
		</View>
		<If when={shown()}>
			<ChatScreen day={day} sessionId="recovery-chat" />
		</If>
	</View>
));
