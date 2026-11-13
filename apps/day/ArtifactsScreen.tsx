// The project's Artifacts page, over Today: every artifact its chats saved,
// newest first, each at its exact saved revision. Opening it reads the list
// once; the newest NSH artifact opens in its isolated preview. Escape hides
// the source or preview opened last, then goes back to Today.
import { keymap, Scroll, Text, View } from "nsh";
import { ArtifactShelf, createShelf } from "./ArtifactShelf";
import { type ArtifactSource, closeArtifacts } from "./artifactReads";
import { keepScroll } from "./kept";

export function ArtifactsScreen(props: { source: ArtifactSource }) {
	const shelf = createShelf();
	keymap.bind(
		"escape",
		() => {
			if (!shelf.hideLast()) closeArtifacts();
		},
		{ when: "always" },
	);
	const scroll = keepScroll("artifacts");
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View testID="artifacts" class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<View class="gap-2">
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						Artifacts
					</Text>
					<Text class="text-sm text-muted-foreground">What chats in this project saved, newest first.</Text>
				</View>
				<ArtifactShelf
					source={props.source}
					shelf={shelf}
					testID="project-artifacts"
					empty="No chat in this project has saved an artifact yet."
				/>
				<Text class="text-xs text-faint">
					Inspect source shows a saved revision as plain text. NSH previews run apart from Pilot and change only
					their own state. Looking records nothing.
				</Text>
			</View>
		</Scroll>
	);
}
