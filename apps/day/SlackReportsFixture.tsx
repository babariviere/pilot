// Fixture data only. Real screen, no provider or Slack access.
import { type JSX, mount, signal, View } from "nsh";
import { SlackReportsScreen } from "./SlackReportsScreen";
import type { SlackControls, SlackSnapshot, ReportDetails } from "./slackControls";
import { restoreSlackReports, savedSlackReports } from "./slackView";
import { Block, Button, Buttons, Caption, GridBackdrop } from "./ui";
import { mirrorIntake, type IntakeSource, type IntakeView } from "./intakeFeed";

const snapshot = signal<SlackSnapshot | null>({
	version: 1,
	projectId: "support",
	projectName: "Customer portal",
	binding: "a".repeat(64),
	config: { channels: [], mentionOnly: [], groups: [] },
	channels: [],
	source: { status: "ok" },
	labels: [{ name: "Export", description: "Exports", effect: "none" }],
	reports: {
		digest: "b".repeat(64),
		total: 2,
		complete: true,
		groups: [{ id: "exports", name: "CSV exports fail", description: "Export failures" }],
		items: [
			{
				id: "report",
				revision: 1,
				triageState: "new",
				projectId: "support",
				title: "CSV export returns an error",
				url: "https://example.slack.com/archives/CDEMO/p1794900000000001",
				caseId: "exports",
				metadata: {
					author: "Maya Chen",
					channelName: "client-northwind",
					details: {
						client: { value: "Northwind", evidence: "Alex at Northwind reports a failed export." },
						reporter: { value: "Alex Morgan", evidence: "Alex Morgan reported this." },
						issue: {
							value: "CSV export returns an error after selecting a date range.",
							evidence: "CSV exports fail after choosing dates.",
						},
					},
				},
				slack: { type: "bug", severity: "high", label: "Export", status: "open", overrides: {} },
			},
			{
				id: "unknown",
				revision: 1,
				triageState: "new",
				projectId: "support",
				title: "Export times out for large date ranges",
				url: "https://example.slack.com/archives/CDEMO/p1794900000000002",
				metadata: { author: "Jules Rivera" },
				slack: { type: "bug", severity: "medium", label: null, status: "open", overrides: {} },
			},
		],
	},
});
const sends = signal(0),
	unknown = signal<{ operationId: string }[]>([]),
	message = signal("");
let generation = 0;
const controls: SlackControls = {
	snapshot,
	busy: () => false,
	message,
	unknown,
	read: async () => {},
	check: async () => {
		message.set("Receipt is still unknown. Nothing was resent.");
	},
	setAside: async () => {},
	open: async () => {
		message.set("Source message opens only outside this fixture.");
	},
	write: async (action, value, binding) => {
		const v = value as {
			digest: string;
			itemId: string;
			patch: { status?: string; details?: ReportDetails };
			edit: { name: string };
		};
		const s = snapshot()!;
		if (binding !== s.binding || v.digest !== s.reports?.digest || unknown().length) return false;
		sends.set(sends() + 1);
		const reports = s.reports!;
		snapshot.set({
			...s,
			reports: {
				...reports,
				digest: String(++generation).padStart(64, "0"),
				groups: action === "group" ? reports.groups.map((g) => ({ ...g, name: v.edit.name })) : reports.groups,
				items: reports.items.map((i) =>
					i.id !== v.itemId
						? i
						: {
								...i,
								slack: {
									...i.slack!,
									status: v.patch.status ?? i.slack!.status,
									overrides: {
										...i.slack!.overrides,
										...(v.patch.status ? { status: v.patch.status } : {}),
										...(v.patch.details ? { details: v.patch.details } : {}),
									},
								},
							},
				),
			},
		});
		return true;
	},
};
const starts = signal(0);
const intakeView: IntakeView = {
	availability: "live",
	reason: "",
	contextDigest: "f".repeat(64),
	projectId: "support",
	intake: { watched: true, sources: ["Slack"], requests: [], trouble: [], more: "" },
	fresh: snapshot()!.reports!.items.map((i) => ({
		revision: i.revision,
		request: {
			id: i.id,
			title: i.title,
			source: "slack",
			sourceLabel: "Slack",
			place: "",
			kind: "bug",
			age: "",
			link: i.url,
			who: "",
			quote: "",
			client: "",
			reporter: "",
		},
	})),
	later: [],
	discarded: [],
	unsettled: [],
	settled: [],
	started: [],
	sending: [],
	canOpen: false,
};
const source: IntakeSource = {
	view: () => intakeView,
	onChange: () => () => {},
	read: async () => {},
	triage: async () => ({ status: "rejected", message: "Not used", operationId: null }),
	check: async () => ({ status: "unknown", message: "Unknown", operationId: null }),
	open: async () => ({ status: "rejected", message: "Not used", operationId: null }),
	dispose: () => {},
	start: async (intent) => {
		starts.set(starts() + 1);
		const s = snapshot()!;
		snapshot.set({
			...s,
			reports: {
				...s.reports!,
				items: s.reports!.items.map((i) =>
					i.id === intent.itemId
						? {
								...i,
								sessionId: "fixture-chat",
								startOperationId: "fixture-start",
								slack: { ...i.slack!, status: "in_progress" },
							}
						: i,
				),
			},
		});
		return { status: "accepted", message: "Started", operationId: "fixture-start" };
	},
};
const day = { slack: controls, intake: mirrorIntake(source) };
const shown = signal(true);
// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => (
	<FixtureWindow>
		<Block gap={1}>
			<Caption tone="faint">Fixture data · Slack reports</Caption>
			<Caption tone="faint">{`Sends: ${sends()}`}</Caption>
			<Caption tone="faint">{`Starts: ${starts()}`}</Caption>
			<Buttons>
				<Button
					small
					label="Save and reopen"
					onPress={() => {
						const saved = savedSlackReports();
						shown.set(false);
						restoreSlackReports(saved);
						shown.set(true);
					}}
				/>
				<Button
					small
					label="External edit"
					onPress={() =>
						snapshot.set({ ...snapshot()!, reports: { ...snapshot()!.reports!, digest: "c".repeat(64) } })
					}
				/>
				<Button small label="Lose reply" onPress={() => unknown.set([{ operationId: "pending" }])} />
			</Buttons>
		</Block>
		<If when={shown()}>
			<SlackReportsScreen day={day} />
		</If>
	</FixtureWindow>
));
