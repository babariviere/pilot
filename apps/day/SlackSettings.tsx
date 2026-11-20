// Slack intake in Settings' Tool connections tab: which channels Pilot reads for this project, and importing one
// message by its link. Opening only reads.
import { effect, untracked, View } from "nsh";
import { keepRead } from "./freshness";
import type { SlackControls, SlackSnapshot } from "./slackControls";
import { safeSlackLink, slackDraft, splitSlackNames } from "./slackDraft";
import { Block, Body, Button, Buttons, Caption, Field, Link, Notice, Picker, Row, Rows, Section } from "./ui";

function draftFrom(s: SlackSnapshot) {
	return {
		projectId: s.projectId,
		binding: s.binding,
		channels: s.config.channels.join(", "),
		mentionOnly: s.config.mentionOnly,
		groups: s.config.groups.join(", "),
		url: "",
	};
}
/** Settings owns unsent words. Native Slack owns effects and source progress. */
export function SlackSettings(props: { controls: SlackControls }) {
	const c = props.controls;
	effect(() => {
		untracked(() => void c.read());
	});
	// Pilot reads again on its own after a failed read, and when the window comes back.
	const reads = keepRead(
		() => c.read(),
		() => c.readFailed?.() ?? false,
		() => !!c.snapshot(),
	);
	effect(() => {
		const s = c.snapshot();
		if (s)
			untracked(() => {
				if (!slackDraft()) slackDraft.set(draftFrom(s));
			});
	});
	const s = () => c.snapshot();
	const d = () => slackDraft();
	const sameProject = () => !!s() && d()?.projectId === s()?.projectId;
	const edit = (patch: Partial<NonNullable<ReturnType<typeof slackDraft>>>) => {
		const old = d();
		if (old) slackDraft.set({ ...old, ...patch });
	};
	const locked = () => c.busy() || c.unknown().length > 0 || !sameProject() || d()?.binding !== s()?.binding;
	const tooMany = () =>
		splitSlackNames(d()?.channels ?? "").length > 100 || splitSlackNames(d()?.groups ?? "").length > 30;
	const sourceLine = () => {
		const source = s()?.source;
		if (!source) return "Coverage is unavailable.";
		if (source.status === "not_configured") return "Tracking off. Saved and imported messages stay available.";
		if (source.status === "sign_in_required")
			return "Slack needs sign-in. Use Tool connections above; saved messages stay available.";
		if (source.status === "error") return `Delayed. ${source.error ?? "Slack could not be read."}`;
		if (source.status === "syncing") return "Reading a small page. Coverage is incomplete.";
		return "Coverage is incomplete. Startup begins seven days back; later polls check new messages in chosen channels.";
	};
	return (
		<View testID="slack-settings">
			<Section
				title="Slack intake"
				note={`Project: ${s()?.projectName ?? "Unavailable"}`}
				action={
					<If when={reads.warn()}>
						<Link label="Try now" testID="slack-read" disabled={c.busy()} onPress={() => void reads.now()} />
					</If>
				}
			>
				<If when={c.message()}>
					<Block>
						<Caption testID="slack-message">{c.message()}</Caption>
					</Block>
				</If>
				<Each of={c.unknown()} key={(o) => o.operationId}>
					{(o) => (
						<>
							<Notice
								kind="unconfirmed"
								placement="section"
								text="An action is Unknown. It will not be sent again."
								action={
									<Link
										label="Check status"
										testID="slack-receipt"
										disabled={c.busy()}
										onPress={() => void c.check(o().operationId)}
									/>
								}
							/>
							<Block>
								<Buttons>
									<Button
										small
										label="Set aside Unknown"
										testID="slack-set-aside"
										disabled={c.busy()}
										onPress={() => void c.setAside(o().operationId)}
									/>
								</Buttons>
								<Caption>
									Set aside checks again, then unlocks Settings if still Unknown. It does not cancel or retry
									the action; the message may already be saved.
								</Caption>
							</Block>
						</>
					)}
				</Each>
				<If when={!s()}>
					<Notice
						kind="needs"
						placement="section"
						text="Slack settings are unavailable. Pilot keeps trying; nothing has been changed."
					/>
				</If>
			</Section>
			<If when={s()}>
				<Section title="Tracked channels" count={s()?.channels.length ?? 0}>
					<Block>
						<Body tone="muted" measure>
							New channels start seven days back. Pilot reads a small page at a time, so busy channels can take
							longer.
						</Body>
						<Body testID="slack-coverage" tone="muted" measure>
							{sourceLine()}
						</Body>
						<If when={s()?.source.status !== "not_configured" && s()?.source.nextPollAt}>
							<Caption>{`Next read no earlier than ${new Date(s()?.source.nextPollAt ?? 0).toLocaleString()}. Shared work and backoff can delay it.`}</Caption>
						</If>
					</Block>
					<Rows>
						<Each of={s()?.channels ?? []} key={(ch) => ch.id}>
							{(ch) => (
								<Row
									title={ch().id}
									meta={
										ch().failedAt && (!ch().pulledAt || ch().failedAt! > ch().pulledAt!)
											? "Last read failed. Coverage has gaps."
											: ch().hasMore
												? "Catching up. More messages remain."
												: ch().pulledAt
													? "Last page read. This is not complete Slack coverage."
													: "Waiting for the first page."
									}
									trailing={
										<If when={ch().pulledAt}>
											<Caption tone="faint">{`Last page read: ${new Date(ch().pulledAt ?? 0).toLocaleString()}`}</Caption>
										</If>
									}
								/>
							)}
						</Each>
					</Rows>
					<Block>
						<Caption>
							Mentions only checks top-level messages for you and your chosen groups. Mentions found only in
							replies are not discovered automatically. Import a message link instead.
						</Caption>
					</Block>
					<If when={!sameProject()}>
						<Notice
							kind="needs"
							placement="section"
							text="Your draft belongs to another project. It has not moved."
							action={
								<Link
									label="Discard other project's draft"
									disabled={c.busy()}
									onPress={() => {
										if (s()) slackDraft.set(draftFrom(s()!));
									}}
								/>
							}
						/>
					</If>
					<If when={sameProject()}>
						<If when={d()?.binding !== s()?.binding}>
							<Notice
								kind="needs"
								placement="section"
								text="Project settings changed while you edited. Your draft stays. Read again before keeping it."
								action={
									<Link
										label="Keep my draft"
										disabled={c.busy() || c.unknown().length > 0}
										onPress={() => edit({ binding: s()?.binding })}
									/>
								}
							/>
						</If>
						<Block>
							<Field
								label="Channel names or IDs"
								testID="slack-channels"
								value={d()?.channels ?? ""}
								help="Separate with commas. Clear this field to stop tracking."
								error={
									tooMany()
										? "Use at most 100 channels and 30 group handles. Your full draft stays in the fields."
										: undefined
								}
								onChange={(channels) => edit({ channels })}
							/>
						</Block>
						<Rows>
							<Each of={splitSlackNames(d()?.channels ?? "").slice(0, 100)} key={(id) => id}>
								{(id) => (
									<Row
										title={id()}
										trailing={
											<Picker
												label={id()}
												placeholder="Include"
												value={d()?.mentionOnly.includes(id()) ? "mentions" : "all"}
												items={[
													{ value: "all", title: "All messages" },
													{ value: "mentions", title: "Mentions only" },
												]}
												onChange={(v) =>
													edit({
														mentionOnly: [
															...(d()?.mentionOnly.filter((ch) => ch !== id()) ?? []),
															...(v === "mentions" ? [id()] : []),
														],
													})
												}
											/>
										}
									/>
								)}
							</Each>
						</Rows>
						<Block gap={3}>
							<Field
								label="Group handles (optional)"
								testID="slack-groups"
								value={d()?.groups ?? ""}
								help="Group matching may be incomplete until Pilot resolves each handle."
								onChange={(groups) => edit({ groups })}
							/>
							<Buttons>
								<Button
									label="Save tracking"
									testID="slack-save"
									disabled={locked() || tooMany()}
									onPress={() => {
										const before = d();
										if (!before) return;
										const channels = splitSlackNames(before.channels);
										void c
											.write(
												"save",
												{
													channels,
													mentionOnly: before.mentionOnly.filter((ch) => channels.includes(ch)),
													groups: splitSlackNames(before.groups),
												},
												before.binding,
											)
											.then((ok) => {
												if (ok && d() === before && s())
													slackDraft.set({ ...draftFrom(s()!), url: before.url });
											});
									}}
								/>
							</Buttons>
						</Block>
					</If>
				</Section>
				<Section title="Import a message">
					<Block gap={3}>
						<Body tone="muted" measure>
							Import from any accessible Slack channel, even when tracking is off. Imported messages stay saved
							independently of tracking.
						</Body>
						<If when={sameProject()}>
							<Field
								label="Slack message link"
								testID="slack-url"
								value={d()?.url ?? ""}
								error={
									d()?.url && !safeSlackLink(d()?.url.trim() ?? "")
										? "Paste a Slack message link without credentials or extra query parameters."
										: undefined
								}
								onChange={(url) => edit({ url })}
							/>
							<Buttons>
								<Button
									label="Import message"
									testID="slack-import"
									disabled={locked() || !safeSlackLink(d()?.url.trim() ?? "")}
									onPress={() => {
										const before = d();
										if (!before) return;
										void c.write("import", { url: before.url.trim() }, before.binding).then((ok) => {
											if (ok && d() === before && s())
												slackDraft.set({ ...before, binding: s()!.binding, url: "" });
										});
									}}
								/>
							</Buttons>
						</If>
						<Caption>
							Uses the Slack connection and background AI allowance. Bounded polling and concurrency, provider
							allowance and Slack rate limits still apply. No extra local operation cap.
						</Caption>
					</Block>
				</Section>
			</If>
		</View>
	);
}
