// Test-only invented source. No providers, accounts or files.
import { mount, Scroll, signal } from "nsh";
import { SlackSettings } from "./SlackSettings";
import type { SlackControls, SlackSnapshot } from "./slackControls";
import { restoreSlackDraft, savedSlackDraft } from "./slackDraft";
import { Block, Button, Buttons, Caption, Column, Page, Panel } from "./ui";

const snapshot = signal<SlackSnapshot | null>({
	version: 1,
	projectId: "support",
	projectName: "Customer support",
	binding: "a".repeat(64),
	config: { channels: ["C123"], mentionOnly: ["C123"], groups: ["support"] },
	source: { status: "ok" },
	channels: [{ id: "C123", pulledAt: 1794843000000, hasMore: true }],
});
const sends = signal(0),
	reads = signal(0),
	checks = signal(0),
	imports = signal(0),
	busy = signal(false),
	message = signal(""),
	unknown = signal<{ operationId: string }[]>([]),
	shown = signal(true),
	lose = signal(false),
	hold = signal(false);
let finish: (() => void) | undefined;
const controls: SlackControls = {
	snapshot,
	busy,
	message,
	unknown,
	read: async () => {
		reads.set(reads() + 1);
	},
	check: async () => {
		checks.set(checks() + 1);
	},
	setAside: async () => {
		checks.set(checks() + 1);
		unknown.set([]);
		lose.set(false);
	},
	write: async (action, value, binding) => {
		if (binding !== snapshot()?.binding) return false;
		sends.set(sends() + 1);
		busy.set(true);
		if (hold())
			await new Promise<void>((r) => {
				finish = r;
			});
		busy.set(false);
		if (lose()) {
			unknown.set([{ operationId: "unknown" }]);
			return false;
		}
		const s = snapshot()!;
		if (action === "save") {
			const v = value as SlackSnapshot["config"];
			snapshot.set({
				...s,
				binding: "b".repeat(64),
				config: v,
				channels: v.channels.map((id) => ({ id })),
				source: { status: v.channels.length ? "idle" : "not_configured" },
			});
		} else {
			imports.set(imports() + 1);
			message.set("Message saved to Today. No channel was added.");
		}
		return true;
	},
};
mount(() => (
	<Scroll class="flex-1">
		<Page width="form">
			<Block>
				<Caption tone="faint">Mock data · Slack settings</Caption>
				<Caption>{`Sends: ${sends()}, reads: ${reads()}, checks: ${checks()}, imports: ${imports()}`}</Caption>
				<Buttons>
					<Button label="Toggle Settings" onPress={() => shown.set(!shown())} />
					{/* A read as Pilot starts one on its own (a change, the window coming back). */}
					<Button label="Fixture read" onPress={() => void controls.read()} />
					<Button label="Restore draft" onPress={() => restoreSlackDraft(savedSlackDraft())} />
					<Button
						label="External change"
						onPress={() => snapshot.set({ ...snapshot()!, binding: "c".repeat(64) })}
					/>
					<Button
						label="Other project"
						onPress={() => snapshot.set({ ...snapshot()!, projectId: "other", projectName: "Other project" })}
					/>
					<Button label="Lose reply" onPress={() => lose.set(true)} />
					<Button label="Delay write" onPress={() => hold.set(true)} />
					<Button
						label="Finish write"
						onPress={() => {
							hold.set(false);
							finish?.();
						}}
					/>
					<Button
						label="Rate limit"
						onPress={() =>
							snapshot.set({
								...snapshot()!,
								source: { status: "error", error: "Slack rate limit", nextPollAt: 1794846000000 },
							})
						}
					/>
					<Button label="Unavailable" onPress={() => snapshot.set(null)} />
				</Buttons>
			</Block>
			<If when={shown()}>
				<Panel>
					<Column>
						<SlackSettings controls={controls} />
					</Column>
				</Panel>
			</If>
		</Page>
	</Scroll>
));
