import { cleanup, keymap, Scroll, signal, Text, View } from "nsh";
import type { KnowledgeDetail } from "../../packages/protocol/src/knowledge";
import { type Shown, readRefused } from "./artifactReads";
import { ArtifactBody, ArtifactTools, paneLine } from "./ArtifactViewer";
import { artifactPreviewsAvailable } from "./bridge";
import { InspectInWindow } from "./InspectionWindow";
import { backTarget, type Places } from "./nav";
import { Action, Page, PageTitle } from "./ui";
import type { DetailHit, WorkSearchSource } from "./workSearch";

export function SearchDetailScreen(props: { places: Places; hit: DetailHit; source: WorkSearchSource }) {
	const artifact = signal<Shown | null>(null);
	const knowledge = signal<KnowledgeDetail | null>(null);
	const reading = signal(true);
	let generation = 0;
	cleanup(() => {
		generation++;
	});
	async function read() {
		const turn = ++generation;
		const hit = props.hit;
		reading.set(true);
		if (hit.kind === "output") {
			const result = await props.source.output(hit).catch(() => readRefused("unknown"));
			if (turn !== generation) return;
			artifact.set({
				title: hit.title,
				kind: hit.target.kind,
				pin: { revision: hit.target.revision ?? 0 },
				state: result.status,
				artifact: result.status === "shown" ? result.artifact : null,
				message: result.status === "refused" ? result.message : "",
				preview:
					result.status === "shown" &&
					result.artifact.content.state === "text" &&
					hit.target.kind === "nsh" &&
					artifactPreviewsAvailable(),
			});
		} else {
			const detail = await props.source.knowledge(hit).catch(() => null);
			if (turn !== generation) return;
			knowledge.set(detail);
		}
		reading.set(false);
	}
	void read();
	const readableArtifact = () =>
		artifact()?.state === "shown" && artifact()?.artifact?.content.state !== "unavailable";
	keymap.bind("escape", () => backTarget(props.places)?.go(), { when: "always" });
	return (
		<Scroll class="flex-1 bg-background">
			<Page gap={8}>
				<View class="gap-1">
					<Text class="text-xs text-muted-foreground">
						{`${props.hit.projectName} · ${props.hit.kind === "output" ? "Saved output" : "Knowledge"}`}
					</Text>
					<PageTitle title={props.hit.title} />
					<If when={!reading() && (readableArtifact() || knowledge())}>
						<InspectInWindow
							title={props.hit.title}
							context={`${props.hit.projectName} · Revision ${props.hit.target.revision}`}
							text={knowledge()?.revision.body}
							artifact={artifact() ?? undefined}
						/>
					</If>
				</View>
				<If when={reading()}>
					<Text class="text-sm text-muted-foreground">Reading the saved revision…</Text>
				</If>
				<Each of={artifact() && !reading() ? [artifact() as Shown] : []} key={(item) => item.pin.revision}>
					{(item) => (
						<View class="gap-3">
							<View class="flex-row items-center gap-2">
								<Text class="min-w-0 flex-1 text-sm text-muted-foreground">{paneLine(item())}</Text>
								<If
									when={
										item().artifact?.content.state === "text" &&
										item().kind === "nsh" &&
										artifactPreviewsAvailable()
									}
								>
									<Action
										label={item().preview ? "Inspect source" : "Show preview"}
										onPress={() => artifact.set({ ...item(), preview: !item().preview })}
									/>
									<If when={item().preview}>
										<Action label="Reset" onPress={() => void read()} />
									</If>
								</If>
								<ArtifactTools shown={item()} testID="search-output" />
							</View>
							<ArtifactBody shown={item()} />
							<If when={item().state === "refused"}>
								<Action label="Try again" onPress={() => void read()} />
							</If>
						</View>
					)}
				</Each>
				<If when={props.hit.kind === "knowledge" && !reading()}>
					<If
						when={knowledge()}
						else={
							<View class="items-start gap-2">
								<Text class="text-sm text-muted-foreground">This Knowledge revision could not be read.</Text>
								<Action label="Try again" onPress={() => void read()} />
							</View>
						}
					>
						<View selectable class="gap-3">
							<Text class="text-xs text-muted-foreground">
								{`Revision ${knowledge()?.revision.revision}${knowledge()?.freshness.state === "needs_check" ? " · Needs a check" : ""}`}
							</Text>
							<Text class="text-sm text-foreground">{knowledge()?.revision.body ?? ""}</Text>
						</View>
					</If>
				</If>
			</Page>
		</Scroll>
	);
}
