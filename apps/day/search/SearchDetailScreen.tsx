import { cleanup, keymap, Scroll, signal } from "nsh";
import type { KnowledgeDetail } from "../../../packages/protocol/src/knowledge/knowledge";
import { backTarget, type Places } from "../app/nav";
import { ArtifactBody, ArtifactTools, paneLine } from "../artifacts/ArtifactViewer";
import { readRefused, type Shown } from "../artifacts/artifactReads";
import { InspectInWindow } from "../artifacts/InspectionWindow";
import { artifactPreviewsAvailable } from "../sources/bridge";
import { Block, Body, Button, Buttons, Caption, Column, EmptyLine, Link, Page, PageHead, Panel, Section } from "../ui";
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
		<Scroll class="flex-1">
			<Page>
				<PageHead
					pre={
						<Caption>{`${props.hit.projectName} · ${props.hit.kind === "output" ? "Saved output" : "Knowledge"}`}</Caption>
					}
					title={props.hit.title}
					actions={
						<If when={!reading() && (readableArtifact() || knowledge())}>
							<InspectInWindow
								title={props.hit.title}
								context={`${props.hit.projectName} · Revision ${props.hit.target.revision}`}
								text={knowledge()?.revision.body}
								artifact={artifact() ?? undefined}
							/>
						</If>
					}
				/>
				<Panel>
					<Column>
						<If when={reading()}>
							<Section title={props.hit.kind === "output" ? "Saved output" : "Knowledge"}>
								<EmptyLine text="Reading the saved revision…" />
							</Section>
						</If>
						<Each of={artifact() && !reading() ? [artifact() as Shown] : []} key={(item) => item.pin.revision}>
							{(item) => (
								<Section
									title="Saved output"
									note={paneLine(item())}
									action={
										<If when={item().state === "refused"}>
											<Link label="Try again" onPress={() => void read()} />
										</If>
									}
								>
									<Block gap={3}>
										<Buttons>
											<If
												when={
													item().artifact?.content.state === "text" &&
													item().kind === "nsh" &&
													artifactPreviewsAvailable()
												}
											>
												<Button
													small
													label={item().preview ? "Inspect source" : "Show preview"}
													onPress={() => artifact.set({ ...item(), preview: !item().preview })}
												/>
												<If when={item().preview}>
													<Button small label="Reset" onPress={() => void read()} />
												</If>
											</If>
											<ArtifactTools shown={item()} testID="search-output" />
										</Buttons>
										<ArtifactBody shown={item()} />
									</Block>
								</Section>
							)}
						</Each>
						<If when={props.hit.kind === "knowledge" && !reading()}>
							<If
								when={knowledge()}
								else={
									<Section title="Knowledge" action={<Link label="Try again" onPress={() => void read()} />}>
										<EmptyLine text="This Knowledge revision could not be read." />
									</Section>
								}
							>
								<Section
									title="Knowledge"
									note={`Revision ${knowledge()?.revision.revision}${knowledge()?.freshness.state === "needs_check" ? " · Needs a check" : ""}`}
								>
									<Block selectable>
										<Body measure>{knowledge()?.revision.body ?? ""}</Body>
									</Block>
								</Section>
							</If>
						</If>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
