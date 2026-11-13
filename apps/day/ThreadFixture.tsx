// Headless fixture only. No daemon, worker, provider or storage. Mission
// threads over scripted topics (threadDemo.ts): `Next …` picks what the next
// write does, "Hold" makes the coordinator unable to take a message,
// "Coordinator replies" writes its answer, and "Save and reopen" keeps the
// window as a close or an update saves it and shows it again fresh.
import { mount, signal, Text, View } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { ScriptedThreads, type ThreadsDemoNext } from "./threadDemo";
import { mirrorThreads } from "./threadFeed";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const threads = new ScriptedThreads();
const day = { ...openDay(), threads: mirrorThreads(threads) };

const NEXT: ThreadsDemoNext[] = ["unknown", "stale", "reject"];

/** The thread and unsent words the last saved window kept. */
const kept = signal("");

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 px-6 pt-2">
			<Text testID="counts">{`Writes: ${threads.writes()} · Sends: ${threads.sends()} · Checks: ${threads.checks()}`}</Text>
			<Each of={NEXT} key={(n) => n}>
				{(n) => <Action label={`Next ${n()}`} onPress={() => threads.next.set(n())} />}
			</Each>
			<Action label="Hold" onPress={() => threads.held.set(true)} />
			<Action label="Unreadable" onPress={() => threads.unreadable.set(true)} />
			<Action label="Changed elsewhere" onPress={() => threads.changeElsewhere("search")} />
			<Action label="Coordinator replies" onPress={() => threads.reply("search", "PDFs can wait. I noted it.")} />
			<Action
				label="Save and reopen"
				onPress={() => {
					const v = captureView(day.today());
					kept.set(`${v.thread ?? ""} | ${(v.threads ?? []).join(" | ")}`);
					startFresh();
					restoreView(v, undefined, day.today());
				}}
			/>
			<Text testID="kept">{`Kept: [${kept()}]`}</Text>
		</View>
		<DayScreen day={day} />
	</View>
));
