import { cleanup, effect, keymap, signal, Text, View } from "nsh";
import type { Shown } from "./artifactReads";
import { artifactSelection } from "./deliveryArtifact";
import type { ArtifactLink, DeliveredWork, DeliverySource } from "./deliveryFeed";
import { SourcePanel } from "./SourcePanel";
import { Action, Picker } from "./ui";

/** Compare only outputs pinned to this displayed result. No inferred before/after pairing. */
export function OutputComparison(props: { work: DeliveredWork; source: DeliverySource; fresh: boolean }) {
	const opened = signal(false);
	const selected = signal<Record<string, string>>({});
	const shown = signal<Record<string, Shown>>({});
	let generation = 0;
	const id = (a: ArtifactLink) => `${a.sessionId}/${a.artifactId}/${a.revision}`;
	const links = () => props.work.artifacts.filter((a) => artifactSelection(props.work, a));
	const reset = () => {
		generation++;
		selected.set({});
		shown.set({});
	};
	let lastResult = "";
	effect(() => {
		const key = `${props.work.targetId}/${props.work.deliveryId}/${props.work.ownerSessionId}/${props.fresh}/${links().map(id).join(",")}`;
		if (key === lastResult) return;
		lastResult = key;
		reset();
	});
	effect(() => {
		if (!opened()) return;
		cleanup(
			keymap.bind(
				"escape",
				() => {
					reset();
					opened.set(false);
				},
				{ when: "always" },
			),
		);
	});
	const choose = async (side: string, value: string) => {
		const link = links().find((a) => id(a) === value);
		if (!link || !props.fresh) return;
		const run = generation;
		selected.update((all) => ({ ...all, [side]: value }));
		const reading: Shown = {
			title: link.title,
			kind: link.kind,
			pin: { revision: link.revision! },
			state: "reading",
			artifact: null,
			message: "",
		};
		shown.update((all) => ({ ...all, [side]: reading }));
		const result = await props.source.inspect(props.work, link);
		if (generation !== run || selected()[side] !== value || !props.fresh) return;
		shown.update((all) => ({
			...all,
			[side]:
				result.status === "shown"
					? { ...reading, state: "shown", artifact: result.artifact }
					: { ...reading, state: "refused", message: result.message },
		}));
	};
	return (
		<If when={links().length > 1 && props.fresh}>
			<View class="gap-2">
				<Action
					label={opened() ? "Close comparison" : "Compare outputs"}
					testID="outputs-compare"
					onPress={() => {
						reset();
						opened.set(!opened());
					}}
				/>
				<If when={opened()}>
					<Text class="text-xs text-faint">
						Choose which saved outputs are Before and After. Looking records nothing.
					</Text>
					<Each of={["Before", "After"]} key={String}>
						{(side) => (
							<View class="gap-2">
								<Text role="header" class="text-sm font-medium text-foreground">
									{side()}
								</Text>
								<Picker
									label={side()}
									testID={`outputs-${side().toLowerCase()}`}
									placeholder="Choose output"
									items={links().map((a) => ({
										value: id(a),
										title: `${a.title || "Artifact"} · revision ${a.revision}`,
									}))}
									value={selected()[side()] ?? null}
									onChange={(value) => void choose(side(), value)}
								/>
								<If when={shown()[side()]}>
									<SourcePanel inspection={shown()[side()]} />
								</If>
							</View>
						)}
					</Each>
				</If>
			</View>
		</If>
	);
}
