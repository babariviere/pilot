// The saved records behind the Wayfinder map: one question, one fog area and
// the agreement. The outline rows and the chart's field notes show the same
// records. Reading them answers, approves and starts nothing.
import { View } from "nsh";
import type { Exploration, ExploreKind, FogArea, MapInfo, PlanPage } from "pilot-day/native";
import type { Plans } from "../../missions/planning/planning";
import { Body, Caption, Link, type MarkKind, Row, Rows } from "../../ui";
import { MapSources } from "./MapSources";

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

/**
 * A question's state mark: Needs you while it asks, Working while it runs or is ready to, Done once settled, and the
 * quiet New mark while it waits (for other questions, or for Pilot to record finished research).
 */
export function exploreMark(e: Exploration): MarkKind {
	switch (e.state) {
		case "asking":
			return "needs";
		case "running":
			return e.findingsWaiting ? "new" : "working";
		case "resolved":
			return "done";
		case "ready":
			return "working";
		default:
			return "new";
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
				<Caption tone="faint">{props.title}</Caption>
				<Each of={props.lines} key={(l) => l}>
					{(l) => <Body>{`• ${l()}`}</Body>}
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
			<Body>{e().question}</Body>
			<If when={e().evidence}>
				<Body>{e().evidence}</Body>
			</If>
			<If when={e().limits}>
				<Caption tone="faint">{`Prototype limits: ${e().limits}`}</Caption>
			</If>
			<Detail title="What the prototype showed" lines={e().observations} />
			<Detail title="What it left open" lines={e().unresolved} />
			<If when={round()}>
				<View testID={`settled-round-${e().id}`} class="gap-2">
					<Caption tone="faint">{`${round()?.title ?? ""} · your answers, as submitted`}</Caption>
					<Each of={round()?.answers ?? []} key={(a) => a.prompt}>
						{(a) => (
							<View class="gap-0.5">
								<Caption>{a().prompt}</Caption>
								<Body>{a().answer || "No answer"}</Body>
							</View>
						)}
					</Each>
				</View>
			</If>
			<MapSources plans={props.plans} page={props.page} area="item" recordId={e().id} refs={e().sourceRefs} />
			<If when={origin()}>
				<Caption tone="faint">{origin()}</Caption>
			</If>
		</View>
	);
}

/** One fog area's record: why it matters, when it is ready or what it became, and its sources. */
export function FogRecord(props: { plans: Plans; page: PlanPage; fog: FogArea }) {
	const f = () => props.fog;
	return (
		<View class="gap-1">
			<Body tone="muted">{f().why}</Body>
			<Caption tone="default">
				{f().active ? `Ready when: ${f().readyWhen}` : `Became: ${f().became.join(", ")}`}
			</Caption>
			<MapSources plans={props.plans} page={props.page} area="fog" recordId={f().id} refs={f().sourceRefs} />
			<Caption tone="faint">
				{[
					f().after.length > 0 ? `After: ${f().after.join(", ")}` : "",
					f().sources.length > 0 ? `From ${f().sources.join(", ")}` : "",
				]
					.filter(Boolean)
					.join(" · ")}
			</Caption>
		</View>
	);
}

/** The agreement and the tasks it became. Opening a task shows the mission overview; it starts nothing. */
export function Agreement(props: { info: MapInfo; onOpenTasks?: () => void }) {
	return (
		<If when={props.info.agreement || props.info.tasks.length > 0}>
			<View testID="map-agreement" class="gap-1">
				<Caption tone="faint">Agreement</Caption>
				<Body>{props.info.agreement}</Body>
				<Rows>
					<Each of={props.info.tasks} key={(t) => t.id}>
						{(t) => (
							<Row
								title={t().title}
								meta={t().number > 0 ? `#${t().number}` : undefined}
								state={t().status}
								wrap
							/>
						)}
					</Each>
				</Rows>
				<If when={props.info.tasks.length > 0 && props.onOpenTasks}>
					<Link label="Open the tasks" onPress={() => props.onOpenTasks?.()} />
				</If>
			</View>
		</If>
	);
}
