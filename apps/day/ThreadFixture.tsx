// Headless fixture only. No daemon, worker, provider or storage. Mission
// threads over scripted topics (threadDemo.ts): `Next …` picks what the next
// write does, "Hold" makes the coordinator unable to take a message,
// "Unreadable" and "Denied" make reads fail, "Pages fail" fails only
// conversation and activity reads, "Open a gone thread" opens one no read
// has, "Coordinator replies" writes an answer linked to the scope thread
// (… "elsewhere" to the release thread, "Coordinator works" to none),
// "Hold reads" keeps page reads waiting until "Release reads", "Old words …"
// and "Reply links …" change what the service reports above the reader, "Where"
// says the scroll offset and where the message being read sits in the
// viewport, and "Save and reopen" keeps the window as a close or an update
// saves it and shows it again fresh.
import { mount, signal, View } from "nsh";
import { scrollOf } from "./app/kept";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { captureView, restoreView, startFresh } from "./app/windowState";
import { ScriptedDelivery } from "./missions/delivery/deliveryDemo";
import { mirrorDelivery } from "./missions/delivery/deliveryFeed";
import { readingProbe } from "./sessions/ThreadScreen";
import { ScriptedThreads, type ThreadsDemoNext } from "./sessions/threadDemo";
import { mirrorThreads } from "./sessions/threadFeed";
import { openThread, refreshOpenThread } from "./sessions/threadView";
import { Block, Button, Buttons, Caption } from "./ui";

const threads = new ScriptedThreads();
const day = { ...openDay(), threads: mirrorThreads(threads), delivery: mirrorDelivery(new ScriptedDelivery()) };

const NEXT: ThreadsDemoNext[] = ["unknown", "stale", "reject"];

/** The thread and unsent words the last saved window kept. */
const kept = signal("");

/** The scope thread's kept scroll offset, as its page last reported it. */
const where = signal("");

/** The message the thread keeps in place and its distance from the viewport's top. */
const anchor = signal("");
let probes = 0;

mount(() => (
	<View class="flex-1">
		<Block>
			<Buttons>
				<Caption testID="counts">{`Writes: ${threads.writes()} · Sends: ${threads.sends()} · Checks: ${threads.checks()}`}</Caption>
				<Caption testID="reads">{`Page reads: ${threads.reads()}`}</Caption>
				<Each of={NEXT} key={(n) => n}>
					{(n) => <Button label={`Next ${n()}`} onPress={() => threads.next.set(n())} />}
				</Each>
				<Button label="Hold" onPress={() => threads.held.set(true)} />
				{/* A read as Pilot starts one on its own: a service change reads the open thread. */}
				<Button label="Fixture read" onPress={() => refreshOpenThread(day.threads)} />
				<Button label="Unreadable" onPress={() => threads.unreadable.set(true)} />
				<Button
					label="Denied"
					onPress={() => {
						threads.refusal.set("denied");
						threads.unreadable.set(true);
					}}
				/>
				<Button label="Open a gone thread" onPress={() => openThread("search", "search-gone")} />
				<Button label="Changed elsewhere" onPress={() => threads.changeElsewhere("search")} />
				<Button label="Hand off" onPress={() => threads.handOff("search")} />
				<Button label="Resolve" onPress={() => threads.resolve("search")} />
				<Button
					label="Coordinator replies"
					onPress={() => threads.reply("search", "PDFs can wait. I noted it.", ["search-scope"])}
				/>
				<Button
					label="Coordinator replies elsewhere"
					onPress={() => threads.reply("search", "Tagged releases only.", ["search-release"])}
				/>
				<Button
					label="Coordinator works"
					onPress={() => threads.reply("search", "I ran the exporter tests for another task.")}
				/>
				<Button label="Chat replies" onPress={() => threads.chatReply("search", "CSV first, then JSON.")} />
				<Button
					label="Coordinator busy"
					onPress={() => threads.busy("search", "Markdown export is ready to review.")}
				/>
				<Button label="Place waiting" onPress={() => threads.placeWaiting("search")} />
				<Button label="Old words unplaced" onPress={() => threads.unplace("search")} />
				<Button label="Old words placed" onPress={() => threads.placeOld("search")} />
				<Button label="Reply links unknown" onPress={() => threads.learnLinks("search", false)} />
				<Button label="Reply links learned" onPress={() => threads.learnLinks("search", true)} />
				<Button
					label="Where"
					onPress={() => {
						where.set(`Scroll: ${Math.round(scrollOf("thread/search/search-scope"))}`);
						const n = ++probes;
						void readingProbe().then((p) =>
							anchor.set(p ? `Anchor ${n}: ${p.key} ${Math.round(p.top)}` : `Anchor ${n}: none`),
						);
					}}
				/>
				<Caption testID="where">{where()}</Caption>
				<Caption testID="anchor">{anchor()}</Caption>
				<Button label="Pages fail" onPress={() => threads.pagesFail.set(true)} />
				<Button label="Pages work" onPress={() => threads.pagesFail.set(false)} />
				<Button label="Unlinked replies" onPress={() => threads.unlinked.set(true)} />
				<Button label="Replies unknown" onPress={() => threads.replyUnknown.set(true)} />
				<Button label="Turn ended" onPress={() => threads.turnEnded.set(true)} />
				<Button label="Hold reads" onPress={() => threads.holdReads.set(true)} />
				<Button label="Release reads" onPress={() => threads.releaseReads()} />
				<Button
					label="Save and reopen"
					onPress={() => {
						const v = captureView(day.today());
						kept.set(`${v.thread ?? ""} | ${(v.threads ?? []).join(" | ")}`);
						startFresh();
						restoreView(v, undefined, day.today());
					}}
				/>
				<Caption testID="kept">{`Kept: [${kept()}]`}</Caption>
			</Buttons>
		</Block>
		<MockDayScreen day={day} />
	</View>
));
