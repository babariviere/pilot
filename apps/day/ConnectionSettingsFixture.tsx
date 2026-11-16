// Invented connections. No network, configuration files or browser sign-ins.
import { mount, Scroll, signal, Text, View } from "nsh";
import { ConnectionSettings } from "./ConnectionSettings";
import type { ConnectionControls, ConnectionSnapshot } from "./connectionControls";
import { restoreConnectionDraft, savedConnectionDraft } from "./connectionDraft";
import { Action } from "./ui";

const snapshot = signal<ConnectionSnapshot | null>({
	version: 1,
	binding: "a".repeat(64),
	readOnly: false,
	setup: {
		entries: [
			{ name: "linear", config: { url: "https://mcp.linear.app/mcp" } },
			{ name: "custom", blocked: "advanced_configuration" },
			{ name: "local", config: { command: "missing-tool" }, dependencyAvailable: false },
		],
		invalidNames: 1,
	},
	status: {
		checking: false,
		configProblems: 1,
		servers: [
			{ name: "linear", state: "needs_sign_in", canSignIn: true },
			{ name: "custom", state: "connected", tools: 4 },
		],
	},
});
const sends = signal(0),
	probes = signal(0),
	reads = signal(0),
	checks = signal(0);
const message = signal(""),
	unknown = signal<{ operationId: string }[]>([]),
	lose = signal(false),
	shown = signal(true);
const controls: ConnectionControls = {
	snapshot,
	busy: () => false,
	message,
	unknown,
	read: async () => {
		reads.set(reads() + 1);
	},
	probe: async () => {
		probes.set(probes() + 1);
	},
	check: async () => {
		checks.set(checks() + 1);
	},
	write: async (action, value, binding) => {
		if (binding && binding !== snapshot()?.binding) {
			message.set("Connections changed. Read again; your draft stays.");
			return false;
		}
		sends.set(sends() + 1);
		if (lose()) {
			unknown.set([{ operationId: "unknown" }]);
			return false;
		}
		const s = snapshot()!;
		if (action === "sign-in")
			snapshot.set({
				...s,
				status: {
					...s.status!,
					servers: s.status!.servers.map((r) =>
						r.name === "linear" ? { ...r, signIn: { state: "waiting", startedAt: 123 } } : r,
					),
				},
			});
		if (action === "cancel")
			snapshot.set({
				...s,
				status: { ...s.status!, servers: s.status!.servers.map((r) => ({ ...r, signIn: undefined })) },
			});
		if (action === "add")
			snapshot.set({
				...s,
				setup: {
					...s.setup,
					entries: [...s.setup.entries, value as ConnectionSnapshot["setup"]["entries"][number]],
				},
			});
		return true;
	},
};
mount(() => (
	<Scroll class="flex-1 bg-background">
		<View class="gap-4 p-6">
			<Text class="text-sm text-faint">Mock data · Tool connections</Text>
			<Text>{`Sends: ${sends()}, checks: ${checks()}, probes: ${probes()}, reads: ${reads()}`}</Text>
			<View class="flex-row flex-wrap gap-2">
				<Action label="Toggle Settings" onPress={() => shown.set(!shown())} />
				<Action label="Lose next reply" onPress={() => lose.set(true)} />
				<Action label="External change" onPress={() => snapshot.set({ ...snapshot()!, binding: "b".repeat(64) })} />
				<Action label="Save and restore draft" onPress={() => restoreConnectionDraft(savedConnectionDraft())} />
				<Action label="Unavailable" onPress={() => snapshot.set(null)} />
			</View>
			<If when={shown()}>
				<ConnectionSettings controls={controls} />
			</If>
		</View>
	</Scroll>
));
