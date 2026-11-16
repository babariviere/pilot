// The saved records behind the Wayfinder map: one question, one fog area and
// the agreement. The outline rows and the chart's field notes show the same
// records. Reading them answers, approves and starts nothing.
import { Text, View } from "nsh";
import type { Exploration, ExploreKind, FogArea, MapInfo, PlanPage } from "pilot-day/native";
import { MapSources } from "./MapSources";
import type { Plans } from "./planning";
import { Action, type MarkKind } from "./ui";

/** Where a question is, in one line. */
export function exploreLine(e: Exploration): string {
	switch (e.state) {
		case "waiting":
			return e.after.length > 0 ? `Waits for: ${e.after.join(", ")}` : "Waiting";
		case "ready":
			return "Ready: what it needs is resolved.";
		case "running":
			if (e.findingsWaiting)
				return "Findings wait for Pilot: the research chat finished, and Pilot records them next.";
			return e.by ? `Running · ${e.by}` : "Running";
		case "asking":
			return "Its questions for you are open above.";
		case "resolved":
			return e.result || "Resolved";
	}
}

/** A question's state mark. */
export function exploreMark(e: Exploration): MarkKind {
	switch (e.state) {
		case "asking":
			return "needs";
		case "running":
			return e.findingsWaiting ? "still" : "moving";
		case "resolved":
			return "done";
		case "ready":
			return "moving";
		default:
			return "unreported";
	}
}

/** What kind of uncertainty a question is, in the words the map uses. */
export function kindWord(kind: ExploreKind): string {
	switch (kind) {
		case "grilling":
			return "Needs your answers";
		case "research":
			return "Needs research";
		case "prototype":
			return "Needs a prototype";
	}
}

/**
 * The word beside a question's row: what it still needs, or, once settled,
 * how it was settled. A settled question needs nothing more from you.
 */
export function itemWord(e: Exploration): string {
	if (e.state === "resolved") return e.round ? "Your answer" : "Settled";
	return kindWord(e.kind);
}

/** A short list under a quiet label, inside a map record. */
function Detail(props: { title: string; lines: string[] }) {
	return (
		<If when={props.lines.length > 0}>
			<View class="gap-0.5">
				<Text class="text-xs text-faint">{props.title}</Text>
				<Each of={props.lines} key={(l) => l}>
					{(l) => <Text class="text-sm leading-relaxed text-foreground">{`• ${l()}`}</Text>}
				</Each>
			</View>
		</If>
	);
}

/** One question's full saved record: what settled it, its findings and its original sources. */
export function ItemRecord(props: { plans: Plans; page: PlanPage; item: Exploration; class?: string }) {
	const e = () => props.item;
	// A question settled in an interview shows that round's answers, as submitted.
	const round = () => (e().round ? (props.page.rounds.find((r) => r.id === e().round) ?? null) : null);
	const origin = () =>
		[e().sources.length > 0 ? `From ${e().sources.join(", ")}` : "", e().fromFog ? `Was fog: ${e().fromFog}` : ""]
			.filter(Boolean)
			.join(" · ");
	return (
		<View testID={`record-${e().id}`} class={`gap-3 ${props.class ?? ""}`}>
			<Text class="text-sm leading-relaxed text-foreground">{e().question}</Text>
			<If when={e().evidence}>
				<Text class="text-sm text-foreground">{e().evidence}</Text>
			</If>
			<If when={e().limits}>
				<Text class="text-xs text-faint">{`Prototype limits: ${e().limits}`}</Text>
			</If>
			<Detail title="What the prototype showed" lines={e().observations} />
			<Detail title="What it left open" lines={e().unresolved} />
			<If when={round()}>
				<View testID={`settled-round-${e().id}`} class="gap-2">
					<Text class="text-xs text-faint">{`${round()?.title ?? ""} · your answers, as submitted`}</Text>
					<Each of={round()?.answers ?? []} key={(a) => a.prompt}>
						{(a) => (
							<View class="gap-0.5">
								<Text class="text-xs text-muted-foreground">{a().prompt}</Text>
								<Text class="text-sm text-foreground">{a().answer || "No answer"}</Text>
							</View>
						)}
					</Each>
				</View>
			</If>
			<MapSources plans={props.plans} page={props.page} area="item" recordId={e().id} refs={e().sourceRefs} />
			<If when={origin()}>
				<Text class="text-xs text-faint">{origin()}</Text>
			</If>
		</View>
	);
}

/** One fog area's record: why it matters, when it is ready or what it became, and its sources. */
export function FogRecord(props: { plans: Plans; page: PlanPage; fog: FogArea }) {
	const f = () => props.fog;
	return (
		<View class="gap-1">
			<Text class="text-sm text-muted-foreground">{f().why}</Text>
			<Text class="text-xs text-foreground">
				{f().active ? `Ready when: ${f().readyWhen}` : `Became: ${f().became.join(", ")}`}
			</Text>
			<MapSources plans={props.plans} page={props.page} area="fog" recordId={f().id} refs={f().sourceRefs} />
			<Text class="text-xs text-faint">
				{[
					f().after.length > 0 ? `After: ${f().after.join(", ")}` : "",
					f().sources.length > 0 ? `From ${f().sources.join(", ")}` : "",
				]
					.filter(Boolean)
					.join(" · ")}
			</Text>
		</View>
	);
}

/** The agreement and the tasks it became. Opening a task shows the mission overview; it starts nothing. */
export function Agreement(props: { info: MapInfo; onOpenTasks?: () => void }) {
	return (
		<If when={props.info.agreement || props.info.tasks.length > 0}>
			<View testID="map-agreement" class="gap-1">
				<Text class="text-xs text-faint">Agreement</Text>
				<Text class="text-sm text-foreground">{props.info.agreement}</Text>
				<Each of={props.info.tasks} key={(t) => t.id}>
					{(t) => (
						<View class="flex-row items-baseline gap-3 py-1">
							<Text class="w-7 text-xs text-faint">{t().number > 0 ? `#${t().number}` : ""}</Text>
							<Text class="flex-1 text-sm text-foreground">{t().title}</Text>
							<Text class="text-xs text-muted-foreground">{t().status}</Text>
						</View>
					)}
				</Each>
				<If when={props.info.tasks.length > 0 && props.onOpenTasks}>
					<View class="flex-row">
						<Action label="Open the tasks" onPress={() => props.onOpenTasks?.()} />
					</View>
				</If>
			</View>
		</If>
	);
}
