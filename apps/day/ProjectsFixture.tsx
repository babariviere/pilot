// Scripted mock data only. No daemon, filesystem, GitHub or credential access.
import { mount, Scroll, signal, Text, View } from "nsh";
import { ProjectsSection } from "./ProjectsSection";
import { type ProjectSetup, type ProjectsSource, restoreProjectSetup, savedProjectSetup } from "./projectSetup";
import { Action } from "./ui";

const writes = signal(0),
	checks = signal(0),
	uncertain = signal(false);
const snapshot: ProjectSetup = {
	version: 1,
	projects: [
		{ id: "one", name: "Harbour", path: "/Users/test/src/harbour", copy: "jj", setup: [], linked: [] },
		{ id: "two", name: "Lighthouse", path: "/Users/test/src/lighthouse", copy: "jj", setup: [] },
	],
	github: { phase: "ready", apiReady: true, sshReady: true, account: "test", sshIdentity: "existing" },
	imports: [
		{
			id: "interrupted",
			url: "https://github.com/test/project",
			destination: "/Users/test/src/project",
			phase: "interrupted",
		},
	],
};
let pending = false;
const source: ProjectsSource = {
	read: async () => ({
		snapshot: { ...snapshot },
		operations: pending ? [{ operationId: "saved-action", state: "unknown" }] : [],
	}),
	preview: async (args) =>
		"path" in args
			? { path: args.path, copy: args.path.endsWith("notes") ? "folder" : "jj", digest: "a".repeat(64) }
			: { destination: "~/src/project", resolvedDestination: "/Users/test/src/project" },
	action: async (args) => {
		writes.set(writes() + 1);
		pending = uncertain();
		if (args.action === "add" && !pending)
			snapshot.projects.push({ id: "new", name: "New project", path: args.path ?? "", copy: "folder", setup: [] });
		if ((args.action === "link" || args.action === "unlink") && !pending)
			snapshot.projects = snapshot.projects.map((p) =>
				p.id !== args.project
					? p
					: {
							...p,
							linked:
								args.action === "link"
									? [...(p.linked ?? []), args.linked ?? ""]
									: (p.linked ?? []).filter((id) => id !== args.linked),
						},
			);
		return {
			snapshot: { ...snapshot },
			operations: pending ? [{ operationId: "saved-action", state: "unknown" }] : [],
			outcome: { operationId: "saved-action", state: pending ? "unknown" : "accepted" },
		};
	},
	check: async () => {
		checks.set(checks() + 1);
		pending = false;
		return { snapshot, operations: [], outcome: { operationId: "saved-action", state: "accepted" } };
	},
};
const shown = signal(true);
mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row items-center gap-2 px-6 py-3">
			<Text>{`Mock data. Actions: ${writes()}. Checks: ${checks()}.`}</Text>
			<Action label="Next uncertain" onPress={() => uncertain.set(true)} />
			<Action
				label="Many projects"
				onPress={() => {
					snapshot.projects = Array.from({ length: 12 }, (_, i) => ({
						id: `project-${i}`,
						name: `Project ${i + 1}`,
						path: `/Users/test/src/project-${i + 1}`,
						copy: "jj",
						setup: [],
					}));
				}}
			/>
			<Action
				label="Save and reopen"
				onPress={() => {
					const saved = savedProjectSetup();
					shown.set(false);
					restoreProjectSetup([]);
					restoreProjectSetup(saved);
					shown.set(true);
				}}
			/>
		</View>
		<Scroll class="flex-1">
			<View class="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
				<If when={shown()}>
					<ProjectsSection source={source} />
				</If>
			</View>
		</Scroll>
	</View>
));
