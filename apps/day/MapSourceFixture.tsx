// Headless source-reading fixture. Invented records, never daemon data.
import { mount, signal, Text, View } from "nsh";
import { openDay } from "./day";
import type { MapSourceRead, MapSourceRequest } from "./mapSourceContract";
import { MockDayScreen, openPlanning } from "./mockFeeds";
import { Action } from "./ui";

const day = openDay("quiet");
const plans = openPlanning("wayfinder");
const feed = plans.feed;
const available = signal(true),
	mismatched = signal(false),
	reads = signal(0);
const result = async (request: MapSourceRequest): Promise<MapSourceRead> => {
	reads.set(reads() + 1);
	if (!available()) return { status: "unavailable" };
	return {
		status: "available",
		detail: {
			...request,
			id: mismatched() ? "another-record" : request.id,
			title: request.kind === "decision" ? "Decision 4" : "Linux keyring access",
			body:
				request.kind === "decision"
					? "Keep the original Wayland choice. 💬"
					: "Exact cited revision 3.\nObserved keyring evidence.",
			currentness: request.kind === "decision" ? "stale" : "current",
			check: "Not checked. Reading does not accept this finding.",
			provenance: [`Canonical ${request.kind} ${request.id}`, "Saved by the fixture user"],
			history: request.kind === "decision" ? ["Replaced by Decision 5. Original record kept."] : [],
		},
	};
};
plans.feed = {
	snapshot: () => feed.snapshot(),
	onChange: (cb) => feed.onChange(cb),
	page: (id) => feed.page(id),
	open: (id) => feed.open(id),
	plan: (i) => feed.plan(i),
	start: (i) => feed.start(i),
	saveAnswer: (i) => feed.saveAnswer(i),
	submit: (i) => feed.submit(i),
	checkSubmit: (i) => feed.checkSubmit(i),
	dispose: () => feed.dispose(),
	readSource: result,
};
mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row gap-2">
			<Action
				label="Revoke source access"
				onPress={() => {
					available.set(false);
					plans.planning.set({ ...plans.planning(), revision: plans.planning().revision + 1 });
				}}
			/>
			<Action label="Wrong source reply" onPress={() => mismatched.set(true)} />
			<Text>{`Source reads: ${reads()}`}</Text>
		</View>
		<MockDayScreen day={day} plans={plans} />
	</View>
));
