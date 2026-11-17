// Quiet, passive activity. Needs you owns attention. The scope read owns
// identity, project access and activity; navigation never sends an intent.
import { computed, signal, Text, View } from "nsh";
import { openChat } from "./chatView";
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
						earlier: state() !== "live" || p.working?.state !== "live",
					},
				];
			}),
		);
	});
	const complete = () =>
		state() === "live" && !!snapshot()?.catalogComplete && projects().every((p) => p.working?.state === "live");
	const note = () => {
		if (state() === "reading") return "Reading working chats…";
		if (state() === "disconnected" || projects().some((p) => p.working?.state === "disconnected"))
			return "Not connected. Working chats are not known.";
		if (state() === "stale") return "Earlier activity. Current work is not known.";
		if (projects().some((p) => p.working?.state === "stale")) return "Earlier activity. Current work is not known.";
		if (state() === "failed") return "Working chats could not be read. This does not mean none are working.";
		if (!complete()) return "Some working chats could not be read. This list may be incomplete.";
		return rows().length === 0 ? "No chat is working now." : "";
	};
	const shown = () => (expanded()[props.ctx.scope()] ? rows() : rows().slice(0, 4));
	return (
		<View testID="working-now" class="gap-3">
			<SectionTitle title="Working now" count={complete() ? rows().length : undefined}>
				<View class="h-8 w-8">
					<If when={props.day.scope && !complete() && state() !== "reading"}>
						<Action
							label="Read activity again"
							icon="refresh"
							iconOnly
							onPress={() => void props.day.scope?.read(props.ctx.scope())}
						/>
					</If>
				</View>
			</SectionTitle>
			<Text testID="working-note" class="min-h-5 text-xs text-muted-foreground">
				{note() || "Activity read is up to date."}
			</Text>
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
		</View>
	);
}
