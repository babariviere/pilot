// The prototype a topic round asks about: the exact revision Pilot linked to
// the mission when its prototype chat ended. Opening it reads that revision
// once and runs it only in the app's isolated preview (or shows its source).
// Looking records nothing; only the answers below settle the question.
import { Text, View } from "nsh";
import type { Exploration, PlanPage } from "pilot-day/native";
import { createShelf, PinnedArtifacts } from "./ArtifactShelf";
import type { ArtifactRow, ArtifactSource } from "./artifactReads";
import { SectionTitle } from "./ui";

/** The prototype question this round asks about, when Pilot made a prototype for it. */
export function roundPrototype(page: PlanPage): Exploration | null {
	return page.explorations.find((e) => e.kind === "prototype" && e.state === "asking" && e.prototype) ?? null;
}

export function RoundPrototype(props: { page: PlanPage; source: ArtifactSource }) {
	const shelf = createShelf();
	const item = () => roundPrototype(props.page);
	const rows = (): ArtifactRow[] => {
		const e = item();
		const pin = e?.prototype;
		return e && pin
			? [
					{
						sessionId: pin.sessionId,
						artifactId: pin.artifactId,
						title: e.title,
						kind: "nsh",
						revision: pin.revision,
						pinned: true,
						updatedAt: 0,
					},
				]
			: [];
	};
	return (
		<If when={item()}>
			<View testID="round-prototype" class="gap-3 rounded-2xl border border-border bg-card px-6 py-5">
				<SectionTitle title="The prototype" />
				<Text class="text-sm leading-relaxed text-muted-foreground">
					{item()?.prototypeCurrent
						? "Pilot made this mock for these questions. Open it, switch between its variants, then answer. It is not the real screen, and looking records nothing."
						: "Pilot made this mock for an earlier map, so it may not match these questions. It is kept as history."}
				</Text>
				<If when={item()?.limits}>
					<Text class="text-xs text-faint">{`Its budget: ${(item()?.limits ?? "").replace(/^About/, "about")}`}</Text>
				</If>
				<PinnedArtifacts source={props.source} shelf={shelf} rows={rows()} />
			</View>
		</If>
	);
}
