import { effect, Text, untracked, View } from "nsh";
import type { SlackControls, SlackSnapshot } from "./slackControls";
import { safeSlackLink, slackDraft, splitSlackNames } from "./slackDraft";
import { Action, Field, Picker, SectionTitle } from "./ui";

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
		<View testID="slack-settings" class="gap-4">
			<View class="gap-1.5">
				<SectionTitle title="Slack intake" />
				<Text class="text-sm text-muted-foreground">Project: {s()?.projectName ?? "Unavailable"}</Text>
			</View>
			<View class="flex-row">
				<Action label="Read again" testID="slack-read" disabled={c.busy()} onPress={() => void c.read()} />
			</View>
			<If when={c.message()}>
				<Text testID="slack-message" class="text-sm text-needs-ink">
					{c.message()}
				</Text>
			</If>
			<Each of={c.unknown()} key={(o) => o.operationId}>
				{(o) => (
					<View class="gap-2">
						<Text class="text-sm text-needs-ink">An action is Unknown. It will not be sent again.</Text>
						<View class="flex-row">
							<Action
								label="Check status"
								testID="slack-receipt"
								disabled={c.busy()}
								onPress={() => void c.check(o().operationId)}
							/>
							<Action
								label="Set aside Unknown"
								testID="slack-set-aside"
								disabled={c.busy()}
								onPress={() => void c.setAside(o().operationId)}
							/>
						</View>
						<Text class="text-xs text-muted-foreground">
							Set aside checks again, then unlocks Settings if still Unknown. It does not cancel or retry the
							action; the message may already be saved.
						</Text>
					</View>
				)}
			</Each>
			<If when={!s()}>
				<Text class="text-sm text-muted-foreground">
					Slack settings are unavailable. Read again; nothing has been changed.
				</Text>
			</If>
			<If when={s()}>
				<View class="gap-3">
					<Text role="header" class="text-base font-semibold text-foreground">
						Tracked channels
					</Text>
					<Text class="text-sm text-muted-foreground">
						New channels start seven days back. Pilot reads a small page at a time, so busy channels can take
						longer.
					</Text>
					<Text testID="slack-coverage" class="text-sm text-muted-foreground">
						{sourceLine()}
					</Text>
					<If when={s()?.source.status !== "not_configured" && s()?.source.nextPollAt}>
						<Text class="text-xs text-muted-foreground">{`Next read no earlier than ${new Date(s()?.source.nextPollAt ?? 0).toLocaleString()}. Shared work and backoff can delay it.`}</Text>
					</If>
					<Each of={s()?.channels ?? []} key={(ch) => ch.id}>
						{(ch) => (
							<View class="gap-1 border-t border-border pt-3">
								<Text class="text-sm font-medium text-foreground">{ch().id}</Text>
								<Text class="text-xs text-muted-foreground">
									{ch().failedAt && (!ch().pulledAt || ch().failedAt! > ch().pulledAt!)
										? "Last read failed. Coverage has gaps."
										: ch().hasMore
											? "Catching up. More messages remain."
											: ch().pulledAt
												? "Last page read. This is not complete Slack coverage."
												: "Waiting for the first page."}
								</Text>
								<If when={ch().pulledAt}>
									<Text class="text-xs text-muted-foreground">{`Last page read: ${new Date(ch().pulledAt ?? 0).toLocaleString()}`}</Text>
								</If>
							</View>
						)}
					</Each>
					<Text class="text-sm text-muted-foreground">
						Mentions only checks top-level messages for you and your chosen groups. Mentions found only in replies
						are not discovered automatically. Import a message link instead.
					</Text>
					<If when={!sameProject()}>
						<Text class="text-sm text-needs-ink">Your draft belongs to another project. It has not moved.</Text>
					</If>
					<If when={sameProject()}>
						<If when={d()?.binding !== s()?.binding}>
							<Text class="text-sm text-needs-ink">
								Project settings changed while you edited. Your draft stays. Read again before keeping it.
							</Text>
							<View class="flex-row">
								<Action
									label="Keep my draft"
									disabled={c.busy() || c.unknown().length > 0}
									onPress={() => edit({ binding: s()?.binding })}
								/>
							</View>
						</If>
						<Field
							label="Channel names or IDs"
							testID="slack-channels"
							value={d()?.channels ?? ""}
							onChange={(channels) => edit({ channels })}
						/>
						<Text class="text-xs text-muted-foreground">
							Separate with commas. Clear this field to stop tracking.
						</Text>
						<If when={tooMany()}>
							<Text class="text-xs text-needs-ink">
								Use at most 100 channels and 30 group handles. Your full draft stays in the fields.
							</Text>
						</If>
						<Each of={splitSlackNames(d()?.channels ?? "").slice(0, 100)} key={(id) => id}>
							{(id) => (
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
							)}
						</Each>
						<Field
							label="Group handles (optional)"
							testID="slack-groups"
							value={d()?.groups ?? ""}
							onChange={(groups) => edit({ groups })}
						/>
						<Text class="text-xs text-muted-foreground">
							Group matching may be incomplete until Pilot resolves each handle.
						</Text>
						<View class="flex-row">
							<Action
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
						</View>
					</If>
					<If when={!sameProject()}>
						<View class="flex-row">
							<Action
								label="Discard other project's draft"
								disabled={c.busy()}
								onPress={() => {
									if (s()) slackDraft.set(draftFrom(s()!));
								}}
							/>
						</View>
					</If>
				</View>
				<View class="gap-3 border-t border-border pt-4">
					<Text role="header" class="text-base font-semibold text-foreground">
						Import a message
					</Text>
					<Text class="text-sm text-muted-foreground">
						Import from any accessible Slack channel, even when tracking is off. Imported messages stay saved
						independently of tracking.
					</Text>
					<If when={sameProject()}>
						<Field
							label="Slack message link"
							testID="slack-url"
							value={d()?.url ?? ""}
							onChange={(url) => edit({ url })}
						/>
						<If when={d()?.url && !safeSlackLink(d()?.url.trim() ?? "")}>
							<Text class="text-xs text-needs-ink">
								Paste a Slack message link without credentials or extra query parameters.
							</Text>
						</If>
						<View class="flex-row">
							<Action
								variant="primary"
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
						</View>
					</If>
					<Text class="text-xs text-muted-foreground">
						Uses the Slack connection and background AI allowance. Bounded polling and concurrency, provider
						allowance and Slack rate limits still apply. No extra local operation cap.
					</Text>
				</View>
			</If>
		</View>
	);
}
