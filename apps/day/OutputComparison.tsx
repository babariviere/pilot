// Before and After for a delivered result: two of the saved outputs pinned to
// the result shown, chosen by the user. No inferred pairing. Tabs switch one
// pane of a fixed height, After first; each side reads its pin once and
// switching reads nothing. A changed result, pin or freshness starts over, and
// a full window opened from here closes with it. Looking records nothing.
// With `pair`, the sides are the worker's named screen captures instead of a choice:
// each side reads its own pin once, when it shows.
import { cleanup, effect, keymap, signal, Text, untracked, View } from "nsh";
import { savedTitle } from "./ArtifactExport";
import { ArtifactBody, ArtifactTools, closeFullFor, InFullNote, inFull, openFull, paneLine } from "./ArtifactViewer";
import type { Shown } from "./artifactReads";
import { artifactSelection } from "./deliveryArtifact";
import type { ArtifactLink, DeliveredWork, DeliverySource } from "./deliveryFeed";
import type { ScreenPair } from "./deliveryScreens";
import { Picker, TabItem, TabRow } from "./ui";

type Side = "Before" | "After";

/** Shows while open; `onClose` closes it (Escape too). `resultKey` names the result's page. */
export function OutputComparison(props: {
	work: DeliveredWork;
	source: DeliverySource;
	fresh: boolean;
	resultKey: string;
	onClose: () => void;
	/** Fixed sides: one screen the worker captured. */
	pair?: ScreenPair;
	/** Prefix of its test IDs (default `outputs`). */
	testID?: string;
}) {
	const side = signal<Side>("After");
	const selected = signal<Record<string, string>>({});
	const shown = signal<Record<string, Shown>>({});
	let generation = 0;
	const tid = props.testID ?? "outputs";
	const fullId = `${tid}:${props.resultKey}`;
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
	cleanup(() => closeFullFor(fullId));
	// It owns Escape first while open; the full window, when open, is newer and goes first.
	keymap.bind(
		"escape",
		() => {
			reset();
			props.onClose();
		},
		{ when: "always" },
	);
	const choose = async (s: Side, value: string) => {
		const link = links().find((a) => id(a) === value);
		if (!link || !props.fresh) return;
		const run = generation;
		selected.update((all) => ({ ...all, [s]: value }));
		const reading: Shown = {
			title: link.title,
			kind: link.kind,
			pin: { revision: link.revision! },
			state: "reading",
			artifact: null,
			message: "",
		};
		shown.update((all) => ({ ...all, [s]: reading }));
		const result = await props.source.inspect(props.work, link);
		// Only this read's answer: not after a reset, another choice, or a later read of the same value.
		if (generation !== run || selected()[s] !== value || shown()[s] !== reading || !props.fresh) return;
		shown.update((all) => ({
			...all,
			[s]:
				result.status === "shown"
					? { ...reading, state: "shown", artifact: result.artifact }
					: { ...reading, state: "refused", message: result.message },
		}));
	};
	const current = () => shown()[side()] ?? null;
	// A pair reads the side shown, once; a reset reads it again.
	effect(() => {
		const pair = props.pair;
		const s = side();
		const link = s === "Before" ? pair?.before : pair?.after;
		if (!link || selected()[s]) return;
		untracked(() => void choose(s, id(link)));
	});
	const missing = () => {
		const pair = props.pair;
		if (!pair) return `Choose which saved output is ${side()}.`;
		if (side() === "After") return pair.after ? "" : "The After capture is no longer linked to this result.";
		if (pair.before === undefined) return "This screen is new. It has no Before.";
		return pair.before ? "" : "The Before capture is no longer linked to this result.";
	};
	const full = (back: () => void) => {
		const s = side();
		const value = selected()[s];
		const pane = shown()[s];
		const run = generation;
		if (!pane || !value) return;
		openFull({
			shown: pane,
			id: fullId,
			side: s,
			// The same side, value and read, on a result still fresh. A reset clears both signals.
			live: () =>
				side() === s && shown()[s] === pane && selected()[s] === value && generation === run && props.fresh,
			back,
		});
	};
	return (
		<View testID={`${tid}-comparison`} class="gap-2 rounded-xl border border-border p-3">
			{/* The tabs keep their own width; when the row is narrow, the icons wrap below them, never under them. */}
			<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
				<View class="flex-row">
					<TabRow>
						<TabItem
							label="Before"
							selected={side() === "Before"}
							testID={`${tid}-tab-before`}
							onPress={() => side.set("Before")}
						/>
						<TabItem
							label="After"
							selected={side() === "After"}
							testID={`${tid}-tab-after`}
							onPress={() => side.set("After")}
						/>
					</TabRow>
				</View>
				<If when={current()}>
					<View class="ml-auto">
						<ArtifactTools shown={current() as Shown} testID={tid} onFull={full} />
					</View>
				</If>
			</View>
			<If when={!props.pair}>
				<View class="flex-row">
					<Picker
						label={`${side()} output`}
						testID={`${tid}-${side().toLowerCase()}`}
						placeholder={`Choose the ${side()} output`}
						items={links().map((a) => ({
							value: id(a),
							title: `${a.title || "Artifact"} · revision ${a.revision}`,
						}))}
						value={selected()[side()] ?? null}
						onChange={(value) => void choose(side(), value)}
					/>
				</View>
			</If>
			<If when={current()} else={<Text class="text-sm text-muted-foreground">{missing()}</Text>}>
				<View class="flex-row flex-wrap items-baseline gap-x-2">
					<Text testID={`${tid}-title`} class="text-sm font-medium text-foreground">
						{savedTitle(current() as Shown)}
					</Text>
					<Text class="text-xs text-faint">{paneLine(current() as Shown)}</Text>
				</View>
				<If when={!inFull(fullId)} else={<InFullNote />}>
					<Each of={[side()]} key={String}>
						{() => <ArtifactBody shown={current() as Shown} bounded />}
					</Each>
				</If>
			</If>
			<Text class="text-xs text-faint">
				{props.pair
					? "The agent captured these from the app, without its change and with it. Looking records nothing."
					: "Before and After are saved outputs of this result. Looking records nothing."}
			</Text>
		</View>
	);
}
