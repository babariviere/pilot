// Headless fixture only: the mock topic interview with notes and questions offered. Sends are
// counted, and a question gets a canned answer at once. Mock data.
import { mount, Scroll, signal } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { InterviewDoc } from "./InterviewDoc";
import { openPlanning } from "./mockFeeds";
import { Column, Page, PageFoot, Panel, Section, WindowCanvas } from "./ui";

const plans = openPlanning("wayfinder");
const source = plans.feed;
await source.open("linux");
const original = source.page("linux") as PlanPage;
const page = signal<PlanPage>({ ...original, canComment: true });
const sent = signal<string[]>([]);
const feed = Object.assign(Object.create(Object.getPrototypeOf(source)), source, {
	page: () => page(),
	// Methods, as the connected feed's: called unbound, they would throw.
	async continuePlanning(this: unknown, intent: { missionId: string; feedback: string }) {
		if (this !== plans.feed) throw new Error("continuePlanning called without its feed");
		sent.set([...sent(), intent.feedback]);
		page.set({ ...page(), canComment: false });
		return {
			status: "accepted" as const,
			revision: 1,
			missionId: intent.missionId,
			message: "Sent. Pilot redoes these questions with your feedback.",
		};
	},
	async askQuestion(this: unknown, intent: { missionId: string; questionId: string; text: string }) {
		if (this !== plans.feed) throw new Error("askQuestion called without its feed");
		const p = page();
		const interview = p.interview!;
		const questions = interview.questions.map((q) =>
			q.id === intent.questionId
				? {
						...q,
						asks: [
							...q.asks,
							{
								id: `ask-${q.asks.length + 1}`,
								text: intent.text,
								state: "answered" as const,
								answer: "GNOME and KDE cover most Linux users.",
								reason: "",
							},
						],
					}
				: q,
		);
		page.set({ ...p, interview: { ...interview, questions } });
		return {
			status: "accepted" as const,
			revision: 1,
			missionId: intent.missionId,
			message: "Asked. The answer shows here.",
		};
	},
});
plans.feed = feed;
mount(() => (
	<WindowCanvas>
		<Scroll class="flex-1">
			<Page>
				<Panel>
					<Column>
						<Section title="Questions">
							<InterviewDoc plans={plans} page={page()} interview={page().interview!} />
						</Section>
					</Column>
				</Panel>
				<PageFoot testID="sent" text={`Sent: ${JSON.stringify(sent())}`} />
			</Page>
		</Scroll>
	</WindowCanvas>
));
