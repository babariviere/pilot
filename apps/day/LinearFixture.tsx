// Headless fixture only. No daemon, worker, provider, Linear or storage.
// The connected window's Linear page over a scripted saved read
// (linearDemo.ts) and a New section with Linear requests, so the page can
// point back to them. "Save and reopen" keeps the window as a close or an
// update saves it and shows it again in a fresh window state.
import { mount, signal, View } from "nsh";
import type { Request } from "pilot-day/native";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { captureView, restoreView, startFresh } from "./app/windowState";
import { type IntakeSource, type IntakeView, mirrorIntake } from "./missions/intake/intakeFeed";
import { type LinearDemoMode, ScriptedLinear } from "./sources/linear/linearDemo";
import { mirrorLinear } from "./sources/linear/linearFeed";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const linear = new ScriptedLinear();

function request(id: string, key: string, title: string): Request {
	return {
		id,
		source: "linear",
		sourceLabel: "Linear",
		title,
		place: key,
		kind: "",
		age: "",
		link: "",
		who: "",
		quote: "",
		client: "",
		reporter: "",
	};
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
	canOpen: false,
};
const refuse = async () => ({ status: "rejected" as const, message: "Not in this fixture.", operationId: null });
const intake: IntakeSource = {
	view: () => intakeView,
	onChange: () => () => {},
	read: async () => {},
	triage: refuse,
	start: refuse,
	check: refuse,
	open: refuse,
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
	<WindowCanvas>
		<Block>
			<Buttons>
				<Caption testID="reads">{`Reads: ${linear.reads()}`}</Caption>
				{/* A read as Pilot starts one on its own (a change, the window coming back). */}
				<Button small label="Fixture read" onPress={() => void day.linear.source.read()} />
				<Button small label="Forget reads" onPress={() => linear.forget()} />
				<Each of={MODES} key={(m) => m[0]}>
					{(m) => <Button small label={`Mode ${m()[0]}`} onPress={() => linear.mode.set(m()[1])} />}
				</Each>
				<Button
					small
					label="Save and reopen"
					onPress={() => {
						const v = captureView(day.today());
						kept.set(v.linear ?? "");
						startFresh();
						restoreView(v, undefined, day.today(), true);
					}}
				/>
				<Caption testID="kept">{`Kept: [${kept()}]`}</Caption>
			</Buttons>
		</Block>
		<View class="min-h-0 flex-1">
			<MockDayScreen day={day} />
		</View>
	</WindowCanvas>
));
