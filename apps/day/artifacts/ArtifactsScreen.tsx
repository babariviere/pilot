// The project's Artifacts page, over Today: a shelf of every artifact its
// chats saved, newest first, each at its exact saved revision. Opening it
// reads the list once and starts no preview. Escape closes the open
// artifact, then goes back to Today.
import { keymap, Scroll } from "nsh";
import { keepScroll } from "../app/kept";
import { pageScroll, scrolled } from "../app/onScreen";
import { Column, Page, PageFoot, PageHead, Panel, Section } from "../ui";
import { ArtifactShelf, createShelf } from "./ArtifactShelf";
import { type ArtifactSource, closeArtifacts } from "./artifactReads";

export function ArtifactsScreen(props: { source: ArtifactSource; onBackFromJump?: () => boolean }) {
	const shelf = createShelf();
	keymap.bind(
		"escape",
		() => {
			if (!shelf.hideLast() && !props.onBackFromJump?.()) closeArtifacts();
		},
		{ when: "always" },
	);
	const scroll = keepScroll("artifacts");
	return (
		<Scroll
			class="flex-1"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			ref={pageScroll}
			onScroll={(e) => {
				scroll.onScroll(e);
				scrolled();
			}}
		>
			<Page testID="artifacts">
				<PageHead title="Artifacts" text="What chats in this project saved, newest first." />
				<Panel testID="artifacts-panel">
					<Column>
						<Section title="Saved artifacts">
							<ArtifactShelf
								source={props.source}
								shelf={shelf}
								testID="project-artifacts"
								empty="No chat in this project has saved an artifact yet."
							/>
						</Section>
					</Column>
				</Panel>
				<PageFoot text="Open one to see a saved image, NSH preview or readable source. Previews run apart from Pilot, change only their own state and pause out of view. Looking records nothing." />
			</Page>
		</Scroll>
	);
}
