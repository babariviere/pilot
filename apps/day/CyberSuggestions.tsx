// Today's one question per project that hit cyber blocks twice while Cyber work is off there: allow it, or Not now.
// It reads the project setup on open and when the window comes back; Allow Cyber uses the same project write as
// Settings › Projects. The service shows it once: after either answer it does not ask again for that project.
import { effect, lifecycle, signal, Text, untracked, View } from "nsh";
import { nativeProjects, type ProjectsReply, type ProjectsSource } from "./projectSetup";
import { todayProject } from "./todayScope";
import { Action } from "./ui";

type Suggestion = { id: string; name: string };

export function CyberSuggestions(props: { source?: ProjectsSource }) {
	const source = props.source ?? nativeProjects;
	const shown = signal<Suggestion[]>([]);
	const busy = signal("");
	const take = (reply: ProjectsReply) => {
		const next = (reply.snapshot?.projects ?? []).filter((p) => p.suggestCyber).map(({ id, name }) => ({ id, name }));
		if (JSON.stringify(next) !== JSON.stringify(untracked(shown))) shown.set(next);
	};
	// Not connected, or an older service: no question, never an error on Today.
	const read = () => source.read().then(take, () => {});
	void read();
	let was = untracked(lifecycle);
	effect(() => {
		const now = lifecycle();
		if (now === "active" && was !== "active") void read();
		was = now;
	});
	const answer = async (project: string, allow: boolean) => {
		busy.set(project);
		try {
			take(
				await source.action(
					allow ? { action: "allow-profile", project, profile: "cyber" } : { action: "cyber-not-now", project },
				),
			);
		} catch {
			// The project write keeps its own Unknown state in Settings. Today reads again on the next focus.
		} finally {
			busy.set("");
		}
	};
	const visible = () => shown().filter((p) => todayProject() === "all" || todayProject() === p.id);
	return (
		<Each of={visible()} key={(p) => p.id}>
			{(p) => (
				<View
					testID={`cyber-suggestion-${p().id}`}
					class="gap-3 rounded-2xl border border-border-strong bg-card px-6 py-5"
				>
					<Text class="text-base font-semibold text-card-foreground">
						{`${p().name} hit cyber blocks twice. Allow Cyber work in this project?`}
					</Text>
					<Text class="text-sm text-muted-foreground">
						The planner can then give its security tasks the Cyber profile, and Pilot sends a blocked turn again
						with a Cyber model. You can change it in Settings › Projects.
					</Text>
					<View class="flex-row gap-2">
						<Action
							variant="primary"
							label="Allow Cyber"
							testID={`cyber-allow-${p().id}`}
							disabled={busy() !== ""}
							onPress={() => void answer(p().id, true)}
						/>
						<Action
							label="Not now"
							testID={`cyber-not-now-${p().id}`}
							disabled={busy() !== ""}
							onPress={() => void answer(p().id, false)}
						/>
					</View>
				</View>
			)}
		</Each>
	);
}
