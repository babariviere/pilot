// Key hints: the keys that work here, as small mono caps beside their words ("⌘↩ Decide  J K Next").
import { Text, View } from "nsh";
import { narrow } from "./layout";
import { TYPE } from "./text";

/** A key the user can press, as a small mono cap. `on` fills it: the choice it picks is chosen. */
export function KeyCap(props: { label: string; on?: boolean }) {
	return (
		<View
			class={`items-center justify-center rounded-md px-1 ${props.on === true ? "bg-primary" : "bg-muted"}`}
			style={{ minWidth: 18, height: 18 }}
		>
			<Text
				class={`font-mono ${props.on === true ? "text-primary-foreground" : "text-muted-foreground"}`}
				style={{ ...TYPE.number, fontWeight: "500" }}
			>
				{props.label}
			</Text>
		</View>
	);
}

/** One key hint: its keys as caps and what they do, such as "⌘↩ Decide" or "J K Next". */
export function KeyHint(props: { keys: string; label: string }) {
	const caps = () => props.keys.split(" ").filter(Boolean);
	return (
		<View class="flex-row items-center gap-1">
			<Each of={caps()} key={(k) => k}>
				{(k) => <KeyCap label={k()} />}
			</Each>
			<Text class="pl-0.5 text-faint" style={TYPE.caption}>
				{props.label}
			</Text>
		</View>
	);
}

/**
 * A row of key hints at the end of a Question's foot or a composer: `[["⌘↩", "Decide"], ["J K", "Next"]]`. It hides
 * itself in a narrow window: the hints are a keyboard aid, and the buttons stay.
 */
export function KeyHints(props: { hints: [keys: string, label: string][]; testID?: string }) {
	return (
		<If when={!narrow()}>
			<View testID={props.testID} class="flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
				<Each of={props.hints} key={(h) => h.join(" ")}>
					{(h) => <KeyHint keys={h()[0]} label={h()[1]} />}
				</Each>
			</View>
		</If>
	);
}
