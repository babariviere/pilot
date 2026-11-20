import { Image, Scroll, signal, View } from "nsh";
import { currentWindow, Window } from "nsh/desktop";
import type { Shown } from "./artifactReads";
// Parts come file by file, not from "./ui": the inspection test app (fixtures/inspection) loads this module from
// its own folder, where the library's font and icon files (imported by ui/index.ts) are outside the app and cannot
// ship. In Day's window the index has already loaded them.
import { Link } from "./ui/button";
import { WindowCanvas } from "./ui/canvas";
import { Page, PageHead } from "./ui/layout";
import { Column, Panel } from "./ui/panel";
import { Block } from "./ui/section";
import { Body, Caption } from "./ui/text";

/** An immutable copy of already-read evidence, never a live editor or an action source. */
export function InspectInWindow(props: { title: string; context: string; text?: string; artifact?: Shown }) {
	const parent = currentWindow();
	const error = signal("");
	function open() {
		const title = props.title;
		const context = props.context;
		const text = props.text;
		const content = props.artifact?.artifact?.content;
		try {
			const existing = Window.get("inspection");
			if (existing) {
				existing.focus();
				error.set("Close the open inspection window, then try again.");
				return;
			}
			Window.open(
				() => (
					<WindowCanvas>
						<Scroll class="flex-1">
							<Page width="form">
								<PageHead pre={<Caption>{`${context} · Read only`}</Caption>} title={title} />
								<Panel>
									<Column>
										<Block selectable>
											{content?.state === "image" ? (
												<Image
													src={content.source}
													class="h-96 w-full object-contain"
													accessibilityLabel={title}
												/>
											) : (
												<Body>{content?.state === "text" ? content.source : (text ?? "")}</Body>
											)}
										</Block>
									</Column>
								</Panel>
							</Page>
						</Scroll>
					</WindowCanvas>
				),
				{
					id: "inspection",
					parent,
					title,
					kind: "normal",
					defaultSize: { width: 720, height: 620 },
				},
			);
			error.set("");
		} catch {
			error.set("A separate inspection window is unavailable here. This item stays open.");
		}
	}
	return (
		<View class="items-start gap-1">
			<Link label="Open in new window" icon="fullscreen" onPress={open} />
			<If when={error()}>
				<Caption>{error()}</Caption>
			</If>
		</View>
	);
}
