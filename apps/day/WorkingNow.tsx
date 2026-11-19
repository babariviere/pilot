// Quiet, passive activity. Needs you owns attention. The scope read owns
// identity, project access and activity; navigation never sends an intent.
// Chats waiting for a coding slot show under the working ones: no action,
// they start by themselves when their turn comes.
import { computed, signal, Text, View } from "nsh";
import { openChat } from "./chatView";
import { queueLine } from "./codingQueue";
import type { Day } from "./day";
import { OpenChatAction } from "./OpenChatAction";
import type { TodayScope } from "./ScopeRows";
import { Action, Mark, SectionTitle } from "./ui";
import { placeRow } from "./view";

const expanded = signal<Record<string, boolean>>({});

export function WorkingNow(props: { day: Day; ctx: TodayScope }) {
	const read = () => props.day.scope?.view();
	const snapshot = () => (read()?.snapshot?.scope === props.ctx.scope() ? read()?.snapshot : null);
	const state = () => props.day.scope?.activity() ?? "failed";
	const projects = () => snapshot()?.projects.filter((p) => p.selected) ?? [];
	const rows = computed(() => {
		if (state() !== "live" && state() !== "stale") return [];
		const seen = new Set<string>();
		return projects().flatMap((p) =>
			(p.working?.state === "live" || p.working?.state === "stale" ? p.working.items : []).flatMap((r) => {
				if (seen.has(r.sessionId)) return [];
				seen.add(r.sessionId);
				return [
					{
						...r,
						projectId: p.id,
						projectName: p.name,
						// A read crossed by an event during an ordinary refresh is not old: "Was working" flickered on
						// every update. Only the source's own stale state or old data by the 5 minute rule says so.
						earlier: p.working?.state === "stale" || !!read()?.reason,
					},
				];
			}),
		);
	});
	// A read crossed by an event (every few hundred ms while agents stream) is
	// still complete: only old data (a reason) or a project's own state is not.
	const complete = () =>
		(state() === "live" || (state() === "stale" && !read()?.reason)) &&
		!!snapshot()?.catalogComplete &&
		projects().every((p) => p.working?.state === "live");
	const waiting = computed(() => {
		if (state() !== "live" && state() !== "stale") return [];
		const seen = new Set<string>();
		return projects().flatMap((p) =>
			(p.working?.state === "live" || p.working?.state === "stale" ? (p.working.waiting ?? []) : []).flatMap((r) => {
				if (seen.has(r.sessionId)) return [];
				seen.add(r.sessionId);
				return [{ ...r, projectName: p.name }];
			}),
		);
	});
	const note = () => {
		if (state() === "reading") return "Reading working chats…";
		if (state() === "disconnected" || projects().some((p) => p.working?.state === "disconnected"))
			return "Not connected. Working chats are not known.";
		// An earlier read during an ordinary refresh: its rows say "Was working"; no note.
		if (state() === "failed") return "Working chats could not be read. This does not mean none are working.";
		if (!complete()) return "Some working chats could not be read. This list may be incomplete.";
		return rows().length === 0 ? "No chat is working now." : "";
	};
	const shown = () => (expanded()[props.ctx.scope()] ? rows() : rows().slice(0, 4));
	return (
		<View testID="working-now" class="gap-3">
			<SectionTitle title="Working now" count={complete() ? rows().length : undefined}>
				<View class="h-8 w-8" />
			</SectionTitle>
			<If when={note()}>
				<Text testID="working-note" class="text-xs text-muted-foreground">
					{note()}
				</Text>
			</If>
			<Each of={shown()} key={(r) => r.sessionId}>
				{(r) => {
					const place = placeRow(`working-${r().sessionId}`, () => openChat(r().sessionId, "Today"));
					return (
						<View testID={`working-${r().sessionId}`} class="gap-1 border-t border-border py-2">
							<View class="flex-row items-start gap-3">
								<Text class="min-w-0 flex-1 text-sm font-medium text-foreground">
									{r().title || "Unnamed chat"}
								</Text>
								<View class="w-28 flex-row items-center justify-end gap-1.5">
									<Mark kind={r().earlier ? "unreported" : "moving"} />
									<Text class="text-xs text-muted-foreground">{r().earlier ? "Was working" : "Working"}</Text>
								</View>
								<If when={props.day.chat}>
									<OpenChatAction
										anchor={place.anchor}
										testID={`working-open-${r().sessionId}`}
										accessibilityLabel={`Open chat “${r().title || "Unnamed chat"}” in ${r().projectName}`}
										onPress={place.press}
									/>
								</If>
							</View>
							<Text class="text-xs text-muted-foreground">{`${r().projectName} · ${r().missionTitle || (r().missionId ? "Mission title not available" : "Standalone chat")} · ${r().purpose || "Task or purpose not available"}`}</Text>
						</View>
					);
				}}
			</Each>
			<If when={rows().length > 4}>
				<View class="flex-row">
					<Action
						label={expanded()[props.ctx.scope()] ? "Show fewer" : `Show all ${rows().length}`}
						onPress={() => expanded.update((v) => ({ ...v, [props.ctx.scope()]: !v[props.ctx.scope()] }))}
					/>
				</View>
			</If>
			<If when={waiting().length > 0}>
				<View testID="working-waiting" class="gap-1">
					<Text class="text-xs text-faint">{`Waiting · ${waiting().length}`}</Text>
					<Each of={waiting()} key={(r) => r.sessionId}>
						{(r) => {
							const place = placeRow(`waiting-${r().sessionId}`, () => openChat(r().sessionId, "Today"));
							return (
								<View testID={`waiting-${r().sessionId}`} class="gap-1 border-t border-border py-2">
									<View class="flex-row items-start gap-3">
										<Text class="min-w-0 flex-1 text-sm font-medium text-foreground">
											{r().title || "Unnamed chat"}
										</Text>
										<View class="w-28 flex-row items-center justify-end gap-1.5">
											<Mark kind="still" />
											<Text class="text-xs text-muted-foreground">Waiting</Text>
										</View>
										<If when={props.day.chat}>
											<OpenChatAction
												anchor={place.anchor}
												testID={`waiting-open-${r().sessionId}`}
												accessibilityLabel={`Open chat “${r().title || "Unnamed chat"}” in ${r().projectName}`}
												onPress={place.press}
											/>
										</If>
									</View>
									<Text testID={`waiting-line-${r().sessionId}`} class="text-xs text-muted-foreground">
										{`${r().projectName} · ${queueLine(r().queue)}`}
									</Text>
								</View>
							);
						}}
					</Each>
				</View>
			</If>
		</View>
	);
}
