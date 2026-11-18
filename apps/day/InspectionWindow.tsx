import { Image, Scroll, signal, Text, View } from "nsh";
import { currentWindow, Window } from "nsh/desktop";
import { Action } from "./ui/button";
import { Page, PageTitle } from "./ui/layout";
import type { Shown } from "./artifactReads";

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
					<Scroll class="flex-1 bg-background">
						<Page gap={8}>
							<View class="gap-1">
								<Text class="text-xs text-muted-foreground">{context} · Read only</Text>
								<PageTitle title={title} />
							</View>
							{content?.state === "image" ? (
								<Image src={content.source} class="h-96 w-full object-contain" accessibilityLabel={title} />
							) : (
								<View selectable>
									<Text class="text-sm text-foreground">
										{content?.state === "text" ? content.source : (text ?? "")}
									</Text>
								</View>
							)}
						</Page>
					</Scroll>
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
			<Action label="Open in new window" icon="fullscreen" onPress={open} />
			<If when={error()}>
				<Text class="text-xs text-muted-foreground">{error()}</Text>
			</If>
		</View>
	);
}
