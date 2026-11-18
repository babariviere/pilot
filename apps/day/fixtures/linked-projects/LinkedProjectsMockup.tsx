// MOCKUP. Mock data only: linked projects in Settings > Projects. No daemon, files or effects.
// Run from the repository root: apps/day/nsh.sh run fixtures/linked-projects/LinkedProjectsMockup.tsx
import { mount, Scroll, signal, Text, View } from "nsh";
import { CheckboxRow, Disclosure, SectionTitle } from "../../ui";

type Project = { id: string; name: string; path: string; linked: string[] };
const projects = signal<Project[]>([
	{ id: "phishing", name: "phishing", path: "/Users/you/src/stoikio/phishing", linked: ["eventbus"] },
	{ id: "eventbus", name: "eventbus-schema", path: "/Users/you/src/stoikio/eventbus-schema", linked: [] },
	{ id: "go-libs", name: "go-libs", path: "/Users/you/src/stoikio/go-libs", linked: [] },
]);
const open = signal<string>("phishing");

const names = (p: Project) =>
	p.linked.map((id) => projects().find((other) => other.id === id)?.name ?? "").filter(Boolean);
const toggle = (p: Project, id: string) =>
	projects.set(
		projects().map((each) =>
			each.id !== p.id
				? each
				: {
						...each,
						linked: each.linked.includes(id) ? each.linked.filter((x) => x !== id) : [...each.linked, id],
					},
		),
	);

mount(() => (
	<View class="flex-1 bg-background">
		<View class="px-6 py-3">
			<Text class="text-xs text-faint">Mockup. Mock data.</Text>
		</View>
		<Scroll class="flex-1">
			<View class="mx-auto w-full max-w-3xl gap-4 px-6 py-6">
				<SectionTitle title="Local projects" />
				<Each of={projects()} key={(p) => p.id}>
					{(p) => (
						<View class="gap-1 border-t border-border pt-3">
							<Text class="text-sm font-medium text-foreground">{p().name}</Text>
							<Text class="text-xs text-muted-foreground">Private jj coding copies · Read-only main</Text>
							<Text class="text-xs text-faint">{`Source folder: ${p().path}`}</Text>
							<Disclosure
								label={names(p()).length ? `Also reads: ${names(p()).join(", ")}` : "Also reads: none"}
								open={open() === p().id}
								onToggle={() => open.set(open() === p().id ? "" : p().id)}
							>
								<View class="gap-1 pl-4">
									<Text class="text-xs text-muted-foreground">
										Agents in this project can read the main branch of the projects you tick. Read-only.
									</Text>
									<Each of={projects().filter((other) => other.id !== p().id)} key={(o) => o.id}>
										{(o) => (
											<CheckboxRow
												label={o().name}
												checked={p().linked.includes(o().id)}
												onChange={() => toggle(p(), o().id)}
											/>
										)}
									</Each>
								</View>
							</Disclosure>
						</View>
					)}
				</Each>
			</View>
		</Scroll>
	</View>
));
