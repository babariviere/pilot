// Quiet, passive activity. Needs you owns attention. The scope read owns
// identity, project access and activity; navigation never sends an intent.
// Chats waiting for a coding slot show under the working ones: no action,
// they start by themselves when their turn comes.
import { computed, signal } from "nsh";
import { openChat } from "./chatView";
import { queueLine } from "./codingQueue";
import type { Day } from "./day";
import { OpenChatAction } from "./OpenChatAction";
import type { TodayScope } from "./ScopeRows";
import { EmptyLine, Row, RowGroup, Rows, Section } from "./ui";
import { placeRow } from "./view";

const expanded = signal<Record<string, boolean>>({});

/** The chats working now and waiting for a slot in the scope Today shows, and what Pilot can say about the read. */
export function workingList(day: Day, ctx: TodayScope) {
	const read = () => day.scope?.view();
	const snapshot = () => (read()?.snapshot?.scope === ctx.scope() ? read()?.snapshot : null);
	const state = () => day.scope?.activity() ?? "failed";
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
	/** The count Today shows: only when the read is complete, so a partial list never reads as all of it. */
	const count = () => (complete() ? rows().length : null);
	return { rows, waiting, complete, note, count };
}

export type WorkingList = ReturnType<typeof workingList>;

/** How many working chats show before Show all: a short list, the rest one press away. */
const SHOWN = 4;

export function WorkingNow(props: { day: Day; ctx: TodayScope; list: WorkingList }) {
	const list = props.list;
	const shown = () => (expanded()[props.ctx.scope()] ? list.rows() : list.rows().slice(0, SHOWN));
	return (
		<Section
			testID="working-now"
			title="Working now"
			count={list.count()}
			more={
				list.rows().length > SHOWN
					? {
							label: expanded()[props.ctx.scope()] ? "Show fewer" : `Show all ${list.rows().length}`,
							onPress: () => expanded.update((v) => ({ ...v, [props.ctx.scope()]: !v[props.ctx.scope()] })),
						}
					: undefined
			}
		>
			<If when={list.note()}>
				<EmptyLine testID="working-note" text={list.note()} />
			</If>
			<Rows>
				<Each of={shown()} key={(r) => r.sessionId}>
					{(r) => {
						const place = placeRow(`working-${r().sessionId}`, () => openChat(r().sessionId, "Today"));
						return (
							<Row
								testID={`working-${r().sessionId}`}
								mark={r().earlier ? "unconfirmed" : "working"}
								title={r().title || "Unnamed chat"}
								meta={`${r().projectName} · ${r().missionTitle || (r().missionId ? "Mission title not available" : "Standalone chat")} · ${r().purpose || "Task or purpose not available"}`}
								state={r().earlier ? "Was working" : "Working"}
								trailing={
									<If when={props.day.chat}>
										<OpenChatAction
											anchor={place.anchor}
											testID={`working-open-${r().sessionId}`}
											accessibilityLabel={`Open chat “${r().title || "Unnamed chat"}” in ${r().projectName}`}
											onPress={place.press}
										/>
									</If>
								}
							/>
						);
					}}
				</Each>
			</Rows>
			<If when={list.waiting().length > 0}>
				<RowGroup testID="working-waiting" label={`Waiting · ${list.waiting().length}`} />
				<Rows>
					<Each of={list.waiting()} key={(r) => r.sessionId}>
						{(r) => {
							const place = placeRow(`waiting-${r().sessionId}`, () => openChat(r().sessionId, "Today"));
							return (
								<Row
									testID={`waiting-${r().sessionId}`}
									mark="new"
									title={r().title || "Unnamed chat"}
									meta={`${r().projectName} · ${queueLine(r().queue)}`}
									state="Waiting"
									trailing={
										<If when={props.day.chat}>
											<OpenChatAction
												anchor={place.anchor}
												testID={`waiting-open-${r().sessionId}`}
												accessibilityLabel={`Open chat “${r().title || "Unnamed chat"}” in ${r().projectName}`}
												onPress={place.press}
											/>
										</If>
									}
								/>
							);
						}}
					</Each>
				</Rows>
			</If>
		</Section>
	);
}
