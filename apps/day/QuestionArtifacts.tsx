// The artifacts a chat attached to its question, such as a mockup to look at
// before answering. Opening one reads its saved revision once; it sends
// nothing and answers nothing.
import { View } from "nsh";
import type { DecisionArtifact } from "pilot-day/native";
import { createShelf, PinnedArtifacts } from "./ArtifactShelf";
import type { ArtifactRow, ArtifactSource } from "./artifactReads";
import { Caption } from "./ui";

export function QuestionArtifacts(props: { source: ArtifactSource; artifacts: DecisionArtifact[]; label?: string }) {
	const shelf = createShelf();
	const rows = (): ArtifactRow[] =>
		props.artifacts.map((a) => ({
			sessionId: a.sessionId,
			artifactId: a.artifactId,
			title: a.title || "Untitled artifact",
			kind: a.kind,
			revision: a.revision,
			pinned: true,
			updatedAt: 0,
		}));
	return (
		<View testID="question-artifacts" class="gap-2">
			<Caption>
				{props.label ??
					(props.artifacts.length === 1
						? "The chat attached this to look at:"
						: "The chat attached these to look at:")}
			</Caption>
			<PinnedArtifacts source={props.source} shelf={shelf} rows={rows()} />
		</View>
	);
}
