// Test-only scripted service. No operational evidence or network access.
import { mount, Scroll, signal, Text, View } from "nsh";
import { DiagnosisReply, DiagnosisSettings } from "./DiagnosisSettings";
import type { DiagnosisControls, DiagnosisOperation, DiagnosisSnapshot } from "./diagnosisControls";
import { restoreDiagnosis, savedDiagnosis } from "./diagnosisDraft";
import { Action } from "./ui";

const snapshot = signal<DiagnosisSnapshot | null>({
	version: 1,
	binding: "a".repeat(64),
	settings: { localDiagnostics: true, localFeatureUsage: false, remoteOperational: false, productAnalytics: false },
	models: [
		{ id: "test/model", provider: "test", name: "Test model", thinkingLevels: ["off"], taskDefaultThinking: "off" },
	],
	chats: { items: [{ sessionId: "specialist", title: "Why did planning wait?", status: "done" }], hasMore: false },
	retained: ["OS logs, service stdout, exports and agent replies are kept independently."],
});
const busy = signal(false),
	message = signal(""),
	operations = signal<DiagnosisOperation[]>([]),
	sends = signal(0),
	checks = signal(0),
	nextUnknown = signal(false),
	reading = signal(0),
	reply = signal(false);
const c: DiagnosisControls = {
	snapshot,
	busy,
	message,
	operations,
	async read() {
		reading.set(reading() + 1);
	},
	async write(action, value) {
		sends.set(sends() + 1);
		if (nextUnknown()) {
			nextUnknown.set(false);
			operations.set([{ operationId: "pending", pending: true, state: "unknown" }]);
			message.set("This action is Unknown.");
			return { accepted: false };
		}
		if (action === "save") {
			snapshot.set({ ...snapshot()!, settings: value as DiagnosisSnapshot["settings"], binding: "b".repeat(64) });
			message.set("Saved. Local collection never enables upload.");
		} else if (action === "clear")
			message.set("Service evidence cleared. This app writer: unconfirmed. Other copies remain.");
		else message.set("Sent to the read-only specialist.");
		return { accepted: true };
	},
	async check() {
		checks.set(checks() + 1);
		message.set("Receipt is still Unknown. Nothing was resent.");
	},
};
mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row gap-2 p-3">
			<Action label="Restore draft" onPress={() => restoreDiagnosis(savedDiagnosis())} />
			<Action label="Next unknown" onPress={() => nextUnknown.set(true)} />
			<Action label="External edit" onPress={() => snapshot.set({ ...snapshot()!, binding: "c".repeat(64) })} />
			<Action label="Show reply" onPress={() => reply.set(!reply())} />
			<Text>{`Sends: ${sends()}, checks: ${checks()}, reads: ${reading()}`}</Text>
		</View>
		<Scroll class="flex-1">
			<View class="w-full max-w-5xl self-center gap-5 px-6 py-6">
				<Text class="text-xs text-muted-foreground">Mock data · no Pilot settings change</Text>
				<If when={reply()} else={<DiagnosisSettings controls={c} />}>
					<DiagnosisReply controls={c} sessionId="specialist" />
				</If>
			</View>
		</Scroll>
	</View>
));
