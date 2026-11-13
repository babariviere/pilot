// Headless fixture only. No daemon, worker, provider, Linear or storage.
// The connected window's Linear page over a scripted saved read
// (linearDemo.ts) and a New section with Linear requests, so the page can
// point back to them. "Save and reopen" keeps the window as a close or an
// update saves it and shows it again in a fresh window state.
import { mount, signal, Text, View } from "nsh";
import type { Request } from "pilot-day/native";
import { type IntakeSource, type IntakeView, mirrorIntake } from "./intakeFeed";
import { type LinearDemoMode, ScriptedLinear } from "./linearDemo";
import { mirrorLinear } from "./linearFeed";
import { MockDayScreen, openDay } from "./mockFeeds";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const linear = new ScriptedLinear();

function request(id: string, key: string, title: string): Request {
	return { id, source: "linear", sourceLabel: "Linear", title, place: key, kind: "", age: "", link: "" };
}

/** New on Today: the Linear requests nobody started. Writes are refused; this fixture tests reading. */
const fresh = [
	request("ln-231", "BIL-231", "CSV export times out for large accounts"),
	request("ln-240", "BIL-240", "Faster search"),
].map((r) => ({ request: r, revision: 1 }));
const intakeView: IntakeView = {
	availability: "live",
	reason: "",
	contextDigest: "a".repeat(64),
	projectId: "mock-project",
	intake: { watched: true, sources: ["Linear"], requests: fresh.map((r) => r.request), trouble: [], more: "" },
	fresh,
	later: [],
	discarded: [],
	unsettled: [],
	settled: [],
	started: [],
	sending: [],
};
const refuse = async () => ({ status: "rejected" as const, message: "Not in this fixture.", operationId: null });
const intake: IntakeSource = {
	view: () => intakeView,
	onChange: () => () => {},
	read: async () => {},
	triage: refuse,
	start: refuse,
	check: refuse,
	dispose: () => {},
};

const day = { ...openDay(), intake: mirrorIntake(intake), linear: mirrorLinear(linear) };

const MODES: [string, LinearDemoMode][] = [
	["saved", "saved"],
	["trouble", "trouble"],
	["not current", "notCurrent"],
	["unset", "unset"],
	["unreadable", "unreadable"],
	["overflow", "overflow"],
	["no cycle", "noCycle"],
	["other project", "otherProject"],
];

/** The last saved Linear place, as the window kept it. */
const kept = signal("");

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 px-6 pt-2">
			<Text testID="reads">{`Reads: ${linear.reads()}`}</Text>
			<Each of={MODES} key={(m) => m[0]}>
				{(m) => <Action label={`Mode ${m()[0]}`} onPress={() => linear.mode.set(m()[1])} />}
			</Each>
			<Action
				label="Save and reopen"
				onPress={() => {
					const v = captureView(day.today());
					kept.set(v.linear ?? "");
					startFresh();
					restoreView(v, undefined, day.today(), true);
				}}
			/>
			<Text testID="kept">{`Kept: [${kept()}]`}</Text>
		</View>
		<MockDayScreen day={day} />
	</View>
));
