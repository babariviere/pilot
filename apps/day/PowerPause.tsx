// The header's notice when Pilot paused work for sleep: one Resume.
import { Text, View } from "nsh";
import type { PowerControls } from "./power";
import { Action } from "./ui";

/** "16:21" for a pause today, or the date and time for an older one. */
function sinceWords(since: number | null): string {
	if (since === null) return "";
	const at = new Date(since);
	const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return at.toDateString() === new Date().toDateString()
		? ` at ${time}`
		: ` on ${at.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** Shown only while work is paused. Agents and started tasks wait until the user resumes or the Mac wakes. */
export function PowerPause(props: { power: PowerControls; narrow: boolean }) {
	const since = () => sinceWords(props.power.view().since);
	return (
		<View testID="power-paused" class="flex-row items-center gap-2">
			<If when={!props.narrow}>
				<Text class="text-xs text-muted-foreground">{props.power.message() || "Work paused for sleep"}</Text>
			</If>
			<Action
				variant="primary"
				label={props.power.busy() ? "Resuming…" : "Resume work"}
				icon="play"
				testID="power-resume"
				disabled={props.power.busy()}
				accessibilityLabel={`Pilot paused all work for sleep${since()}. Resume work now.`}
				onPress={() => void props.power.resume()}
			/>
		</View>
	);
}
