// A page that looks like Pilot: a page head, one panel with tabs, sections of rows and a question. Build pages
// from these parts (`pilot-day/ui`): they carry the app's type, colours, spacing and states. Preview only:
// pressing things changes only this preview.
import { Scroll, signal } from "nsh";
import {
	Body,
	Button,
	Caption,
	Column,
	Columns,
	EmptyLine,
	KeyHints,
	Num,
	Option,
	Options,
	Page,
	PageHead,
	Panel,
	Progress,
	Question,
	Row,
	Rows,
	Section,
	Spacer,
	State,
	Tab,
	Tabs,
} from "pilot-day/ui";

const OPTIONS = [
	{
		id: "flag",
		title: "Ship behind a flag",
		hint: "Off for everyone until support has the guide.",
		tag: "Recommended",
	},
	{ id: "wait", title: "Wait for 2.5", hint: "Two weeks later, with no flag to clean up." },
];

const WORKING = [
	{ id: "billing", title: "Move the billing tables", meta: "Billing · started 2 h ago", done: 3, active: 1, todo: 2 },
	{ id: "uploads", title: "Retry failed uploads", meta: "Uploads · started 20 min ago", done: 1, active: 1, todo: 3 },
];

const DONE = [
	{ id: "search", title: "Faster search results", meta: "Search", at: "09:12" },
	{ id: "export", title: "New export dialog", meta: "Desktop", at: "Yesterday" },
];

type Shown = "overview" | "done";

export default function Artifact() {
	const tab = signal<Shown>("overview");
	const choice = signal("flag");
	const decided = signal(false);
	const chosen = () => OPTIONS.find((o) => o.id === choice())?.title ?? "";
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead
					pre={<Num>Thursday 14 November</Num>}
					title="Release 2.4"
					state={<State kind={decided() ? "working" : "needs"} />}
					text="One decision before the release can start. Two pieces of work are still moving."
					actions={<Button label="Share" icon="share" onPress={() => {}} />}
				/>
				<Panel
					tabs={
						<Tabs>
							<Tab label="Overview" selected={tab() === "overview"} onPress={() => tab.set("overview")} />
							<Tab
								label="Done"
								count={DONE.length}
								selected={tab() === "done"}
								onPress={() => tab.set("done")}
							/>
						</Tabs>
					}
				>
					<If
						when={tab() === "overview"}
						else={
							<Column centered>
								<Section title="Done" count={DONE.length}>
									<Rows>
										<Each of={DONE} key={(d) => d.id}>
											{(d) => (
												<Row mark="done" title={d().title} meta={d().meta} trailing={<Num>{d().at}</Num>} />
											)}
										</Each>
									</Rows>
								</Section>
							</Column>
						}
					>
						<Columns
							main={
								<Section title="Needs you" count={decided() ? 0 : 1}>
									<If
										when={!decided()}
										else={<EmptyLine text={`Decided: ${chosen()}. Nothing was sent; this is a preview.`} />}
									>
										<Question
											title="How should 2.4 ship the new billing page?"
											position="1 of 1"
											meta={
												<>
													<State kind="needs" label="Waiting 2 h" plain />
													<Caption>· Release 2.4</Caption>
												</>
											}
											foot={
												<>
													<Button kind="primary" label="Decide" onPress={() => decided.set(true)} />
													<Button label="Later" onPress={() => tab.set("done")} />
													<Spacer />
													<KeyHints hints={[["⌘↩", "Decide"]]} />
												</>
											}
										>
											<Body measure>
												Support has not seen the new page yet. A flag keeps it hidden until they have.
											</Body>
											<Options>
												<Each of={OPTIONS} key={(o) => o.id}>
													{(o) => (
														<Option
															title={o().title}
															tag={o().tag}
															hint={o().hint}
															checked={choice() === o().id}
															onChange={() => choice.set(o().id)}
														/>
													)}
												</Each>
											</Options>
										</Question>
									</If>
								</Section>
							}
							side={
								<Section title="Working" count={WORKING.length}>
									<Rows>
										<Each of={WORKING} key={(w) => w.id}>
											{(w) => (
												<Row
													mark="working"
													title={w().title}
													meta={w().meta}
													trailing={
														<Progress
															counts={{
																done: w().done,
																review: 0,
																active: w().active,
																blocked: 0,
																todo: w().todo,
															}}
														/>
													}
												/>
											)}
										</Each>
									</Rows>
								</Section>
							}
						/>
					</If>
				</Panel>
			</Page>
		</Scroll>
	);
}
