// An interactive mockup with artifact-local state. Pressing things changes
// only this preview; nothing is saved or sent anywhere.
import { LayoutAnimation, reduceMotion, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Card, Choices, Page, Section } from "pilot-artifact/ui";

const ITEMS = [
	{ id: "a", title: "Rename the billing service", detail: "Two files, one migration." },
	{ id: "b", title: "Fix the flaky upload test", detail: "Timeout raised; root cause unknown." },
	{ id: "c", title: "Update the README", detail: "Setup steps for macOS." },
];

type Layout = "list" | "cards";
const LAYOUTS = [
	{ id: "list", label: "List" },
	{ id: "cards", label: "Cards" },
] as const;

/** Lets the next change glide, unless the reader asked for less motion. */
function glide() {
	if (reduceMotion()) return;
	LayoutAnimation.configureNext({ duration: 180, update: { type: "easeInEaseOut" } });
}

export default function Artifact() {
	const layout = signal<Layout>("list");
	const open = signal<string | undefined>(undefined);
	const choose = (next: Layout) => {
		glide();
		layout.set(next);
	};
	const toggle = (id: string) => {
		glide();
		open.set(open() === id ? undefined : id);
	};
	return (
		<Page title="Inbox layout" subtitle="Preview only. Try both layouts; nothing here changes Pilot.">
			<Choices label="Layout" options={LAYOUTS} value={layout()} onChange={choose} />
			<Section title={layout() === "list" ? "List" : "Cards"}>
				<View class={layout() === "list" ? "gap-0" : "flex-row flex-wrap gap-3"}>
					<Each of={ITEMS} key={(item) => item.id}>
						{(item) => (
							<Button
								onPress={() => toggle(item().id)}
								class={
									layout() === "list"
										? "gap-1 border-b border-border px-1 py-3 hover:bg-accent"
										: "w-56 gap-1 rounded-xl border border-border bg-card p-4 hover:bg-accent"
								}
							>
								<Text class="text-sm font-medium text-foreground">{item().title}</Text>
								<If when={open() === item().id}>
									<Text class="text-sm text-muted-foreground">{item().detail}</Text>
								</If>
							</Button>
						)}
					</Each>
				</View>
			</Section>
			<Card>
				<Text class="text-sm text-muted-foreground">{`Showing ${layout()}; ${open() ? "one item open" : "no item open"}.`}</Text>
			</Card>
		</Page>
	);
}
