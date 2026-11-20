// The prototype a topic round asks about: the exact revision Pilot linked to
// the mission when its prototype chat ended. Opening it reads that revision
// once and runs it only in the app's isolated preview (or shows its source).
// Looking records nothing; only the answers below settle the question.
import type { Exploration, PlanPage } from "pilot-day/native";
import { Block, Body, Caption, Section } from "../ui";
import { createShelf, PinnedArtifacts } from "./ArtifactShelf";
import type { ArtifactRow, ArtifactSource } from "./artifactReads";

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
			<Section testID="round-prototype" title="The prototype">
				<Block gap={3}>
					<Body tone="muted" measure>
						{item()?.prototypeCurrent
							? "Pilot made this mock for these questions. Open it, switch between its variants, then answer. It is not the real screen, and looking records nothing."
							: "Pilot made this mock for an earlier map, so it may not match these questions. It is kept as history."}
					</Body>
					<If when={item()?.limits}>
						<Caption tone="faint">{`Its budget: ${(item()?.limits ?? "").replace(/^About/, "about")}`}</Caption>
					</If>
					<PinnedArtifacts source={props.source} shelf={shelf} rows={rows()} />
				</Block>
			</Section>
		</If>
	);
}
