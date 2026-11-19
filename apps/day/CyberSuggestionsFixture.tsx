// Mock data only: Today's cyber question over a scripted project setup. No service or writes outside this window.
import { mount, signal, Text, View } from "nsh";
import { CyberSuggestions } from "./CyberSuggestions";
import type { ProjectSetup, ProjectsSource } from "./projectSetup";

const actions = signal<string[]>([]);
const snapshot: ProjectSetup = {
	version: 1,
	projects: [
		{ id: "phishing", name: "Phishing", path: "/Users/test/src/phishing", copy: "jj", setup: [], suggestCyber: true },
		{ id: "harbour", name: "Harbour", path: "/Users/test/src/harbour", copy: "jj", setup: [], suggestCyber: true },
		{ id: "quiet", name: "Quiet", path: "/Users/test/src/quiet", copy: "jj", setup: [] },
	],
	github: { phase: "ready", apiReady: true, sshReady: true },
	imports: [],
};
const copy = (): ProjectSetup => JSON.parse(JSON.stringify(snapshot));
const source: ProjectsSource = {
	read: async () => ({ snapshot: copy() }),
	preview: async () => {
		throw new Error("No previews here");
	},
	action: async (args) => {
		actions.set([...actions(), `${args.action} ${args.project}${args.profile ? ` ${args.profile}` : ""}`]);
		snapshot.projects = snapshot.projects.map((p) => (p.id === args.project ? { ...p, suggestCyber: false } : p));
		return { snapshot: copy(), outcome: { operationId: "mock", state: "accepted" } };
	},
	check: async () => ({ snapshot }),
};
mount(() => (
	<View class="flex-1 gap-4 bg-background p-6">
		<Text>{`Mock data. Actions: ${actions().join(", ") || "none"}.`}</Text>
		<CyberSuggestions source={source} />
	</View>
));
