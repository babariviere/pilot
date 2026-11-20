// An interactive mockup with artifact-local state, on Pilot's own parts. Pressing things changes only this
// preview; nothing is saved or sent anywhere.
import { Scroll, signal } from "nsh";
import {
	Body,
	Column,
	Page,
	PageFoot,
	PageHead,
	Panel,
	Row,
	RowDetail,
	RowGroup,
	Rows,
	Section,
	Tab,
	Tabs,
} from "pilot-day/ui";

const ITEMS = [
	{ id: "a", title: "Rename the billing service", detail: "Two files, one migration.", group: "Code" },
	{ id: "b", title: "Fix the flaky upload test", detail: "Timeout raised; root cause unknown.", group: "Tests" },
	{ id: "c", title: "Update the README", detail: "Setup steps for macOS.", group: "Code" },
];
const GROUPS = ["Code", "Tests"];

type Layout = "list" | "grouped";
type Item = (typeof ITEMS)[number];

export default function Artifact() {
	const layout = signal<Layout>("list");
	const open = signal<string | undefined>(undefined);
	const toggle = (id: string) => open.set(open() === id ? undefined : id);
	const row = (item: Item) => (
		<Row
			title={item.title}
			meta={item.group}
			accessibilityLabel={`${item.title}. Show its detail.`}
			onPress={() => toggle(item.id)}
			detail={
				<If when={open() === item.id}>
					<RowDetail>
						<Body tone="muted">{item.detail}</Body>
					</RowDetail>
				</If>
			}
		/>
	);
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead title="Inbox layout" text="Preview only. Try both layouts; nothing here changes Pilot." />
				<Panel
					tabs={
						<Tabs>
							<Tab label="List" selected={layout() === "list"} onPress={() => layout.set("list")} />
							<Tab label="Grouped" selected={layout() === "grouped"} onPress={() => layout.set("grouped")} />
						</Tabs>
					}
				>
					<Column>
						<Section title="Inbox" count={ITEMS.length}>
							<If
								when={layout() === "list"}
								else={
									<Each of={GROUPS} key={(g) => g}>
										{(group) => (
											<>
												<RowGroup
													label={`${group()} · ${ITEMS.filter((i) => i.group === group()).length}`}
												/>
												<Rows>
													<Each of={ITEMS.filter((i) => i.group === group())} key={(i) => i.id}>
														{(item) => row(item())}
													</Each>
												</Rows>
											</>
										)}
									</Each>
								}
							>
								<Rows>
									<Each of={ITEMS} key={(i) => i.id}>
										{(item) => row(item())}
									</Each>
								</Rows>
							</If>
						</Section>
					</Column>
				</Panel>
				<PageFoot text={`Showing ${layout()}; ${open() ? "one item open" : "no item open"}.`} />
			</Page>
		</Scroll>
	);
}
