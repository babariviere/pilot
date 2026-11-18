import { mount, Scroll, signal, Text, View } from "nsh";
import { DatabaseSettings } from "./DatabaseSettings";
import type { DatabaseControls, DatabaseSnapshot } from "./databaseControls";
import { restoreDatabaseDraft, savedDatabaseDraft } from "./databaseDraft";
import { MockDayScreen, openDay } from "./mockFeeds";
import { Action } from "./ui";

const initial: DatabaseSnapshot = {
	version: 1,
	projectId: "atlas",
	binding: "a".repeat(64),
	settings: {
		revision: "first",
		environments: [
			{
				name: "staging",
				read: { host: "db.example", port: "5432", database: "atlas", user: "reader", hasCredentials: true },
			},
		],
	},
	agents: [
		{
			id: "agent",
			title: "Investigate missing invoices",
			provider: "Anthropic",
			eligible: true,
			grants: [],
			request: {
				id: "request",
				env: "staging",
				mode: "read",
				scope: "scope",
				provider: "Anthropic",
				destination: "reader@db.example:5432/atlas",
			},
		},
	],
};
const snapshot = signal<DatabaseSnapshot | null>(initial),
	message = signal(""),
	unknown = signal<{ operationId: string }[]>([]),
	sends = signal(0),
	checks = signal(0),
	reads = signal(0),
	lose = signal(false),
	shown = signal(true);
const controls: DatabaseControls = {
	snapshot,
	busy: () => false,
	current: () => true,
	message,
	unknown,
	read: async () => {
		reads.set(reads() + 1);
	},
	refresh: async () => {
		reads.set(reads() + 1);
	},
	check: async () => {
		checks.set(checks() + 1);
	},
	write: async (action, _value, binding) => {
		if (unknown().length && action !== "revoke") return false;
		if (binding && binding !== snapshot()?.binding) {
			message.set("Settings changed. Your draft stays.");
			return false;
		}
		sends.set(sends() + 1);
		if (lose()) {
			lose.set(false);
			unknown.set([{ operationId: "lost" }]);
			message.set("Unknown. Check status only reads its receipt.");
			return false;
		}
		const s = snapshot()!;
		if (action === "decide" || action === "revoke") snapshot.set({ ...s, agents: [] });
		if (action === "edit") message.set("Saved without connecting.");
		if (action === "test") message.set("Connection authenticated. No SQL was run.");
		return true;
	},
};
const day = { ...openDay("quiet"), databases: controls };
const todayShown = signal(false);
mount(() => (
	<If
		when={todayShown()}
		else={
			<Scroll class="flex-1 bg-background">
				<View class="gap-4 p-6">
					<Text class="text-xs text-faint">Mock data · Database connections</Text>
					<Text>{`Sends: ${sends()}, reads: ${reads()}, checks: ${checks()}`}</Text>
					<View class="flex-row gap-2">
						<Action label="Show Today" onPress={() => todayShown.set(true)} />
						<Action label="Toggle Settings" onPress={() => shown.set(!shown())} />
						<Action label="Save and restore draft" onPress={() => restoreDatabaseDraft(savedDatabaseDraft())} />
						<Action
							label="External change"
							onPress={() => snapshot.set({ ...snapshot()!, binding: "b".repeat(64) })}
						/>
						<Action label="Lose next reply" onPress={() => lose.set(true)} />
						<Action
							label="Make agent ineligible"
							onPress={() =>
								snapshot.set({
									...snapshot()!,
									agents: snapshot()!.agents.map((a) => ({
										...a,
										eligible: false,
										grants: a.request ? [a.request] : a.grants,
									})),
								})
							}
						/>
					</View>
					<If when={shown()}>
						<DatabaseSettings controls={controls} />
					</If>
				</View>
			</Scroll>
		}
	>
		<MockDayScreen day={day} />
	</If>
));
