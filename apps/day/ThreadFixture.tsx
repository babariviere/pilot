// Headless fixture only. No daemon, worker, provider or storage. Mission
// threads over scripted topics (threadDemo.ts): `Next …` picks what the next
// write does, "Hold" makes the coordinator unable to take a message,
// "Unreadable" and "Denied" make reads fail, "Pages fail" fails only
// conversation and activity reads, "Open a gone thread" opens one no read
// has, "Coordinator replies" writes an answer linked to the scope thread
// (… "elsewhere" to the release thread, "Coordinator works" to none),
// "Hold reads" keeps page reads waiting until "Release reads", and "Save and
// reopen" keeps the window as a close or an update saves it and shows it again fresh.
import { mount, signal, Text, View } from "nsh";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { scrollOf } from "./kept";
import { MockDayScreen, openDay } from "./mockFeeds";
import { ScriptedThreads, type ThreadsDemoNext } from "./threadDemo";
import { mirrorThreads } from "./threadFeed";
import { openThread } from "./threadView";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const threads = new ScriptedThreads();
const day = { ...openDay(), threads: mirrorThreads(threads), delivery: mirrorDelivery(new ScriptedDelivery()) };

const NEXT: ThreadsDemoNext[] = ["unknown", "stale", "reject"];

/** The thread and unsent words the last saved window kept. */
const kept = signal("");

/** The scope thread's kept scroll offset, as its page last reported it. */
const where = signal("");

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 px-6 pt-2">
			<Text testID="counts">{`Writes: ${threads.writes()} · Sends: ${threads.sends()} · Checks: ${threads.checks()}`}</Text>
			<Text testID="reads">{`Page reads: ${threads.reads()}`}</Text>
			<Each of={NEXT} key={(n) => n}>
				{(n) => <Action label={`Next ${n()}`} onPress={() => threads.next.set(n())} />}
			</Each>
			<Action label="Hold" onPress={() => threads.held.set(true)} />
			<Action label="Unreadable" onPress={() => threads.unreadable.set(true)} />
			<Action
				label="Denied"
				onPress={() => {
					threads.refusal.set("denied");
					threads.unreadable.set(true);
				}}
			/>
			<Action label="Open a gone thread" onPress={() => openThread("search", "search-gone")} />
			<Action label="Changed elsewhere" onPress={() => threads.changeElsewhere("search")} />
			<Action label="Hand off" onPress={() => threads.handOff("search")} />
			<Action label="Resolve" onPress={() => threads.resolve("search")} />
			<Action
				label="Coordinator replies"
				onPress={() => threads.reply("search", "PDFs can wait. I noted it.", ["search-scope"])}
			/>
			<Action
				label="Coordinator replies elsewhere"
				onPress={() => threads.reply("search", "Tagged releases only.", ["search-release"])}
			/>
			<Action
				label="Coordinator works"
				onPress={() => threads.reply("search", "I ran the exporter tests for another task.")}
			/>
			<Action label="Chat replies" onPress={() => threads.chatReply("search", "CSV first, then JSON.")} />
			<Action
				label="Coordinator busy"
				onPress={() => threads.busy("search", "Markdown export is ready to review.")}
			/>
			<Action label="Place waiting" onPress={() => threads.placeWaiting("search")} />
			<Action
				label="Where"
				onPress={() => where.set(`Scroll: ${Math.round(scrollOf("thread/search/search-scope"))}`)}
			/>
			<Text testID="where">{where()}</Text>
			<Action label="Pages fail" onPress={() => threads.pagesFail.set(true)} />
			<Action label="Pages work" onPress={() => threads.pagesFail.set(false)} />
			<Action label="Unlinked replies" onPress={() => threads.unlinked.set(true)} />
			<Action label="Replies unknown" onPress={() => threads.replyUnknown.set(true)} />
			<Action label="Turn ended" onPress={() => threads.turnEnded.set(true)} />
			<Action label="Hold reads" onPress={() => threads.holdReads.set(true)} />
			<Action label="Release reads" onPress={() => threads.releaseReads()} />
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
		<MockDayScreen day={day} />
	</View>
));
