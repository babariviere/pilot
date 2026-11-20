// Synthetic recovery UI only. No daemon, credentials, processes or filesystem.
import { host, mount, signal } from "nsh";
import { ChatScreen } from "./ChatScreen";
import type { Day } from "./day";
import { restoreRecoveryNotes, savedRecoveryNotes } from "./recoveryDraft";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessionChat";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const sends = signal(0);
const checks = signal(0);
const last = signal("");
const lost = signal(false);
const receiptReady = signal(false);
const shown = signal(true);
const handoff = signal(false);
const chat = signal<SessionChat | null>(null);
const listeners = new Set<(v: SessionChat | null) => void>();
const publish = (v: SessionChat | null) => {
	chat.set(v);
	for (const l of listeners) l(v);
};
host.on("fixture.refresh-chat", () => publish({ ...chat()! }));
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
	...(handoff()
		? {
				fixHandoff: {
					projectId: "project",
					projectName: "Invoices",
					model: "fake/model",
					thinking: "high",
					originalScope: "Fix only CSV export. Evidence: pilot://artifact/original",
					remainingMicros: 1250000,
					allowanceEnabled: true,
				},
			}
		: {}),
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
	async handoffChat(_id, message) {
		sends.update((n) => n + 1);
		last.set(message);
		if (lost()) {
			const pending = {
				status: "unknown" as const,
				kind: "chat-handoff",
				operationId: "handoff-1",
				message: "Check only",
				submittedText: message,
			};
			publish({ ...failed(), pendingRecovery: pending });
			return pending;
		}
		publish({ ...failed(), continuedTo: "successor" });
		return { status: "accepted", message: "", operationId: "handoff-1" };
	},
	async checkContinue() {
		checks.update((n) => n + 1);
		if (handoff())
			return { status: "unknown", kind: "chat-handoff", message: "Check only", operationId: "handoff-1" };
		if (!receiptReady()) return chat()!.pendingRecovery!;
		publish({ ...failed(), state: "working" });
		return { status: "accepted", message: "", operationId: "recover-1" };
	},
};
const day = { chat: mirrorSessionChat(source) } as Day;
mount(() => (
	<WindowCanvas>
		<Block>
			<Buttons>
				<Caption tone="faint">Mock data</Caption>
				<Button label="Hide chat" onPress={() => shown.set(false)} />
				<Button label="Reopen chat" onPress={() => shown.set(true)} />
				<Button label="Lose next answer" onPress={() => lost.set(true)} />
				<Button label="Receipt ready" onPress={() => receiptReady.set(true)} />
				<Button
					label="Offer handoff"
					onPress={() => {
						handoff.set(true);
						publish(failed());
					}}
				/>
				<Button label="Refresh same chat" onPress={() => publish({ ...chat()! })} />
				<Button label="Fail again" onPress={() => publish(failed())} />
				<Button label="Startup failure" onPress={() => publish({ ...failed(), restartOnly: true })} />
				<Button
					label="Setup failed"
					onPress={() =>
						publish({ ...failed(), recoveryBlocked: "Repair setup before retrying. Existing files are kept." })
					}
				/>
				<Button label="Archive view" onPress={() => publish({ ...failed(), archived: true })} />
				<Button
					label="Save and reopen"
					onPress={() => {
						const kept = savedRecoveryNotes();
						shown.set(false);
						restoreRecoveryNotes([]);
						restoreRecoveryNotes(kept);
						shown.set(true);
					}}
				/>
				<Caption>{`Sends: ${sends()} / Checks: ${checks()}`}</Caption>
				<Caption>{`Sent: [${last()}]`}</Caption>
			</Buttons>
		</Block>
		<If when={shown()}>
			<ChatScreen day={day} sessionId="recovery-chat" />
		</If>
	</WindowCanvas>
));
