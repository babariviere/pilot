// Today: what needs the user, which missions move, what landed and what
// comes next. Read-only over the Rust read model, except through intents.
import { Scroll, Text, View } from "nsh";
import type { Decision, MissionRow, MissionState } from "pilot-day/native";
import { DecisionCard, decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { EvidenceChip, InlineAction, Mark, type MarkKind, SectionTitle, Track } from "./ui";
import { focused } from "./view";

const STATE_WORDS: Record<MissionState, string> = {
	moving: "Moving",
	waiting: "Waiting for you",
	stuck: "Stuck",
	unconfirmed: "Unconfirmed",
	paused: "Paused",
	later: "Starts later",
};

const STATE_MARKS: Record<MissionState, MarkKind> = {
	moving: "moving",
	waiting: "needs",
	stuck: "failed",
	unconfirmed: "unknown",
	paused: "paused",
	later: "later",
};

function actionFor(decision: Decision | undefined): string {
	if (!decision) return "";
	if (decision.kind === "review") return "Review it";
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "Check it";
	return "Decide";
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** The headline: the coordinators' summary, until the user starts answering. */
function headline(day: Day): string {
	const today = day.today();
	const left = today.decisions.length;
	if (today.notes.length === 0) return today.headline;
	if (left === 0) return "That was everything. Pilot is back on it.";
	if (left === 1) return "One thing left.";
	return `${WORDS[left] ?? String(left)} things left.`;
}

function total(row: MissionRow): number {
	const p = row.progress;
	return p.done + p.review + p.active + p.blocked + p.todo;
}

function MissionLine(props: { day: Day; row: MissionRow }) {
	const decision = () => props.day.today().decisions.find((d) => d.id === props.row.decisionId);
	return (
		<View class="gap-1.5 border-t border-border py-3.5">
			<View class="flex-row items-baseline gap-3">
				<Text class="flex-1 text-sm font-medium text-foreground">{props.row.title}</Text>
				<View class="flex-row items-center gap-1.5">
					<Mark kind={STATE_MARKS[props.row.state]} />
					<Text
						class="text-xs"
						classList={{
							"text-needs-ink": props.row.state === "waiting" || props.row.state === "unconfirmed",
							"text-failed-ink": props.row.state === "stuck",
							"text-muted-foreground":
								props.row.state === "moving" || props.row.state === "paused" || props.row.state === "later",
						}}
					>
						{STATE_WORDS[props.row.state]}
					</Text>
				</View>
			</View>
			<View class="flex-row flex-wrap items-baseline gap-x-1.5">
				<Text class="text-sm text-muted-foreground">{props.row.line}</Text>
				<If when={decision()}>
					<InlineAction label={actionFor(decision())} onPress={() => focused.set(props.row.decisionId ?? null)} />
				</If>
			</View>
			<View class="flex-row items-center gap-3 pt-1">
				<Track progress={props.row.progress} />
				<Text class="flex-1 text-xs text-faint">{props.row.stage}</Text>
				<Text class="text-xs text-faint">{`${props.row.progress.done} of ${total(props.row)} done`}</Text>
			</View>
		</View>
	);
}

function Decisions(props: { day: Day }) {
	const decisions = () => props.day.today().decisions;
	const front = () => decisions().find((d) => d.id === focused()) ?? decisions()[0];
	const rest = () => decisions().filter((d) => d.id !== front()?.id);
	return (
		<View class="gap-4">
			<SectionTitle title="Decisions" count={decisions().length} />
			<Each of={props.day.today().notes} key={(note) => note}>
				{(note) => (
					<View class="flex-row items-center gap-2.5 rounded-xl bg-ok-soft px-4 py-3">
						<Mark kind="ready" />
						<Text class="flex-1 text-sm text-ok-ink">{note()}</Text>
					</View>
				)}
			</Each>
			<If
				when={front()}
				else={<Text class="text-base text-foreground">No decisions waiting. Pilot keeps going on its own.</Text>}
			>
				<Each of={front() ? [front() as Decision] : []} key={(d) => d.id}>
					{(d) => (
						<DecisionCard
							day={props.day}
							decision={d()}
							index={decisions().indexOf(d())}
							count={decisions().length}
						/>
					)}
				</Each>
			</If>
			<If when={rest().length > 0}>
				<View class="gap-0.5">
					<Each of={rest()} key={(d) => d.id}>
						{(d) => (
							<View class="flex-row items-center gap-2.5 py-1.5">
								<Mark kind={decisionMark(d())} />
								<Text class="flex-1 text-sm text-muted-foreground">
									{"Up next: "}
									<Text class="text-foreground">{d().title}</Text>
								</Text>
								<Text class="text-xs text-faint">{d().effort}</Text>
							</View>
						)}
					</Each>
				</View>
			</If>
		</View>
	);
}

function Missions(props: { day: Day }) {
	const today = () => props.day.today();
	return (
		<View class="gap-3">
			<SectionTitle title="Missions" count={today().moving.length + today().notMoving.length} />
			<If when={today().moving.length > 0}>
				<View>
					<Text class="pb-1.5 text-xs text-faint">{`Moving  ${today().moving.length}`}</Text>
					<Each of={today().moving} key={(m) => m.id}>
						{(m) => <MissionLine day={props.day} row={m()} />}
					</Each>
				</View>
			</If>
			<If when={today().notMoving.length > 0}>
				<View class="pt-3">
					<Text class="pb-1.5 text-xs text-faint">{`Not moving  ${today().notMoving.length}`}</Text>
					<Each of={today().notMoving} key={(m) => m.id}>
						{(m) => <MissionLine day={props.day} row={m()} />}
					</Each>
				</View>
			</If>
		</View>
	);
}

function DoneSince(props: { day: Day }) {
	const today = () => props.day.today();
	return (
		<View class="gap-1">
			<View class="flex-row items-baseline gap-2 pb-2">
				<Text role="header" class="text-sm font-semibold text-muted-foreground">
					Done since you looked
				</Text>
				<Text class="text-sm text-faint">{today().lastLooked}</Text>
			</View>
			<Each of={today().done} key={(e) => e.id}>
				{(e) => (
					<View class="flex-row gap-3 py-2.5">
						<View class="pt-1.5">
							<Mark
								kind={
									e().evidence.some((x) => x.tone === "bad")
										? "failed"
										: e().evidence.some((x) => x.tone === "warn")
											? "needs"
											: "done"
								}
							/>
						</View>
						<View class="flex-1 gap-2">
							<Text class="text-sm text-foreground">{e().text}</Text>
							<View class="flex-row flex-wrap items-center gap-1.5">
								<Each of={e().evidence} key={(x) => x.label}>
									{(x) => <EvidenceChip evidence={x()} />}
								</Each>
								<Text class="text-xs text-faint">{e().missionTitle}</Text>
							</View>
						</View>
					</View>
				)}
			</Each>
			<If when={today().doneHidden > 0}>
				<Text class="pt-1 text-xs text-faint">{`${today().doneHidden} earlier results are not shown here.`}</Text>
			</If>
			<If when={today().finished.length > 0}>
				<Text class="pt-2 text-xs text-muted-foreground">{`Finished: ${today().finished.join(", ")}`}</Text>
			</If>
		</View>
	);
}

function ComingUp(props: { day: Day }) {
	return (
		<View class="gap-1">
			<View class="pb-2">
				<SectionTitle title="Coming up" />
			</View>
			<Each of={props.day.today().comingUp} key={(s) => s.id}>
				{(s) => (
					<View class="flex-row gap-3 py-2">
						<View class="flex-1 gap-0.5">
							<Text class="text-sm text-foreground">{s().text}</Text>
							<If when={s().note}>
								<Text class="text-xs text-faint">{s().note ?? ""}</Text>
							</If>
						</View>
						<Text class="text-xs text-faint">{s().when}</Text>
					</View>
				)}
			</Each>
		</View>
	);
}

/** The whole Today screen for `props.day`. */
export function TodayScreen(props: { day: Day }) {
	const today = () => props.day.today();
	return (
		<Scroll class="flex-1 bg-background">
			<View class="w-full max-w-2xl self-center gap-12 px-6 pb-24 pt-6">
				<View class="flex-row items-center gap-2">
					<View class="size-4 rounded-md bg-primary" />
					<Text class="text-sm font-semibold text-foreground">Pilot</Text>
					<View class="flex-1" />
					<Text class="text-xs text-faint">Mock data</Text>
				</View>

				<View class="gap-3 pt-6">
					<Text class="text-xs text-muted-foreground">{today().dateLine}</Text>
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						{headline(props.day)}
					</Text>
					<Text class="text-base leading-relaxed text-muted-foreground">{today().summary}</Text>
					<If when={today().leftOff && today().decisions.length === 0}>
						<Text class="text-xs text-primary">{today().leftOff ?? ""}</Text>
					</If>
				</View>

				<Decisions day={props.day} />
				<Missions day={props.day} />
				<DoneSince day={props.day} />
				<ComingUp day={props.day} />

				<Text class="border-t border-border pt-5 text-xs text-faint">
					That is everything for now. Pilot will tell you if something needs you.
				</Text>
			</View>
		</Scroll>
	);
}
