import { type JSX, mount, Scroll, signal, View } from "nsh";
import { LinearPublisher, type PublisherIntent, type PublisherSnapshot } from "./LinearPublisher";
import { Block, Column, GridBackdrop, Page, PageFoot, PageHead, Panel, Section } from "./ui";

const parent = {
	title: "Make failed payments recoverable",
	identifier: "BIL-200",
	url: "https://linear.app/billing/issue/BIL-200",
};
const tasks = [
	{ id: "declines", number: 1, title: "Explain a declined payment" },
	{ id: "retry", number: 2, title: "Offer a safe retry" },
];
function Fixture() {
	const enabled = signal(false);
	const pending = signal<string | null>(null);
	const calls = signal<string[]>([]);
	const request = async (missionId: string, intent: PublisherIntent): Promise<PublisherSnapshot> => {
		calls.set([...calls(), intent.action]);
		if (intent.action === "setting") enabled.set(intent.enabled);
		if (intent.action === "publish") pending.set("Explain a declined payment");
		return {
			missionId,
			enabled: enabled(),
			revision: enabled() ? 1 : 0,
			projectName: "Billing Portal",
			parentUrls: [parent.url],
			tasks,
			pending: pending(),
			mappings: [],
			message: "",
			preview:
				intent.action !== "preview"
					? null
					: {
							parent,
							pin: enabled() ? "confirmed-preview" : null,
							edits: [],
							issues: tasks
								.filter((task) => intent.taskIds.includes(task.id))
								.map((task) => ({
									taskId: task.id,
									issue: null,
									before: null,
									change: "create",
									after: {
										title: task.title,
										description:
											"## Outcome\nCustomers know what to do after a decline.\n\n## Acceptance criteria\n- Keep the invoice visible.\n\n## Checks\n- Simulate a card decline.\n\n## Dependencies\n- Review the payment workflow.",
									},
								})),
							links:
								intent.taskIds.length === 2
									? [
											{
												from: "declines",
												to: "retry",
												label: "#1 Explain a declined payment blocks #2 Offer a safe retry",
												change: "add",
											},
										]
									: [],
						},
		};
	};
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead title="Recover failed payments" />
				{/* As the mission page shows it: in a Block of the mission's "In this mission" section. */}
				<Panel>
					<Column>
						<Section title="In this mission">
							<Block>
								<LinearPublisher missionId="fixture" request={request} />
							</Block>
						</Section>
					</Column>
				</Panel>
				<PageFoot text={calls().join(" → ")} />
			</Page>
		</Scroll>
	);
}

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
		<Fixture />
	</FixtureWindow>
));
