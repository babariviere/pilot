// Synthetic attention only. No daemon, filesystem or retry authority: Continue
// and Dismiss go to a script that counts them and drops the row, as the next
// read would.
import { keymap, mount, signal } from "nsh";
import { MockDayScreen, openDay, openMockChat } from "./mockFeeds";
import { mirrorSessionChat, type SessionChatSource } from "./sessionChat";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const sends = signal<string[]>([]);
const base = openMockChat().source;
const drop = (sessionId: string) =>
	day.today.update((t) => ({ ...t, problems: t.problems.filter((p) => p.sessionId !== sessionId) }));
const scripted: SessionChatSource = {
	chat: () => base.chat(),
	onChange: (listener) => base.onChange(listener),
	open: (id) => base.open(id),
	earlier: () => base.earlier(),
	refresh: () => base.refresh(),
	close: (id) => base.close(id),
	checkContinue: (id) => base.checkContinue(id),
	dispose: () => base.dispose(),
	async continueChat(sessionId) {
		sends.update((s) => [...s, `continue ${sessionId}`]);
		drop(sessionId);
		return { status: "accepted", message: "", operationId: "c1" };
	},
	async dismissChat(sessionId) {
		sends.update((s) => [...s, `dismiss ${sessionId}`]);
		drop(sessionId);
		return { status: "accepted", message: "", operationId: "d1" };
	},
	async replyChat(sessionId, message) {
		sends.update((s) => [...s, `reply ${sessionId}: ${message}`]);
		return { status: "accepted", message: "", operationId: "r1" };
	},
};
const day = { ...openDay(), chat: mirrorSessionChat(scripted) };
// A new read of the same rows, without moving the focus.
keymap.bind("mod+shift+1", () => day.today.update((t) => ({ ...t, problems: t.problems.map((p) => ({ ...p })) })), {
	when: "always",
});
day.today.update((t) => ({
	...t,
	problemsKnown: true,
	problems: [
		{
			id: "failed-worker",
			title: "History work stopped",
			cause: "Native checks failed. The coordinator needs your help.",
			nextStep: "Inspect the failed check before choosing how to continue. Nothing is retried here.",
			missionId: "native",
			projectId: "fixture-project",
			canContinue: false,
			canDismiss: false,
			canReply: false,
		},
		{
			id: "session:fixture-chat",
			title: "Tidy the release notes",
			nextStep:
				"Its chat finished with changes but no pull request. See the work, then mark it done or send it back.",
			projectId: "fixture-project",
			sessionId: "fixture-chat",
			canContinue: false,
			canDismiss: false,
			canReply: false,
		},
		{
			id: "session:held-chat",
			title: "Export the audit log",
			cause: "Model request (anthropic): Allowance hold. Check funding in Settings.",
			nextStep: "Continue asks it to try again, once. Or dismiss it.",
			projectId: "fixture-project",
			sessionId: "held-chat",
			canContinue: true,
			canDismiss: true,
			canReply: false,
		},
		{
			id: "session:broken-chat",
			title: "Rename the settings page",
			cause: "Session startup: worker crashed",
			nextStep: "Read its work to choose what to do next, or dismiss it.",
			projectId: "fixture-project",
			sessionId: "broken-chat",
			canContinue: false,
			canDismiss: true,
			canReply: false,
		},
		{
			id: "session:waiting-chat",
			title: "Show working agents on Today",
			cause: "Its chat ended its turn without a result or a question. It may be waiting for your reply.",
			nextStep: "Reply to it, or continue without reply.",
			missionId: "native",
			projectId: "fixture-project",
			sessionId: "waiting-chat",
			canContinue: true,
			canDismiss: false,
			canReply: true,
			says: "The mockup is ready. Should the agent rows sit above Needs you?",
		},
	],
}));

mount(() => (
	<WindowCanvas>
		<MockDayScreen day={day} />
		<Block>
			<Buttons>
				<Button
					label="Stale read"
					onPress={() => day.today.update((t) => ({ ...t, freshness: { ...t.freshness, state: "offline" } }))}
				/>
				<Button label="Resolve problems" onPress={() => day.today.update((t) => ({ ...t, problems: [] }))} />
				<Button
					label="Missing attention"
					onPress={() => day.today.update((t) => ({ ...t, problemsKnown: false }))}
				/>
				<Caption tone="faint">{`Synthetic read. Sent: ${sends().join(", ") || "nothing"}`}</Caption>
			</Buttons>
		</Block>
	</WindowCanvas>
));
