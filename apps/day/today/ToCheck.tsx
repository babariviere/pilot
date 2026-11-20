// Today's To check: delivered results that wait for the user's own check,
// and the user's Done, Send back or Reopen whose answer is not known.
// Pilot also reads new canonical deliveries after the saved start-fresh cutoff.
// Earlier checks and acknowledged standalone starts are kept. Nothing here sends,
// and an agent's report or a merged pull request never counts as a check.
import { signal, View } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type { Day } from "../app/day";
import { restoreScroll, scrollOf } from "../app/kept";
import { placeRow } from "../app/view";
import type { DeliveryEntry, DeliveryMirror, DeliveryOp, DeliveryView } from "../missions/delivery/deliveryFeed";
import {
	openDelivery,
	ownPullRequests,
	settledLine,
	titleOf,
	unsettledLine,
	waitsForCheck,
} from "../missions/delivery/deliveryView";
import { Block, Body, EmptyLine, Link, Notice, Row, RowGroup, Rows, Section } from "../ui";

function missions(day: Day): MissionRow[] {
	const t = day.today();
	return [...t.moving, ...t.notMoving, ...t.unreported];
}

/** Whether a result belongs to the mission shown, or to Today when there is none. */
function inMission(subject: DeliveryOp["subject"], missionId?: string): boolean {
	return !missionId || (subject.kind === "task" && subject.missionId === missionId);
}

/** The results that wait for the user's check, in the read's order: all of them, or one mission's. */
export function checkRows(v: DeliveryView, missionId?: string): DeliveryEntry[] {
	return v.candidates
		.map((key) => v.entries[key])
		.filter(
			(e): e is DeliveryEntry =>
				!!e &&
				inMission(e.subject, missionId) &&
				(waitsForCheck(
					e.snapshot,
					v.unsettled.find((o) => o.key === e.key),
				) ||
					(!!e.snapshot?.pendingOperationId && !v.unsettled.some((o) => o.key === e.key))) &&
				!v.sending.includes(e.key),
		)
		.sort((a, b) => Number(a.snapshot?.reviewQueue === "later") - Number(b.snapshot?.reviewQueue === "later"));
}

/** How many results and unconfirmed checks wait for the user. Needs you counts them. */
export function toCheckCount(day: Day): number {
	const v = day.delivery?.view();
	return v ? checkRows(v).length + v.unsettled.length : 0;
}

/** Today's results that wait for the user's check, in the read's order. Needs you queues them as cards. */
export function todayResults(day: Day): DeliveryEntry[] {
	const v = day.delivery?.view();
	return v ? checkRows(v) : [];
}

/** Checks whose answer Pilot could not confirm. Needs you counts them beside the results. */
export function unsettledCount(day: Day): number {
	return day.delivery?.view().unsettled.length ?? 0;
}

/** A result's name: its task's title, else where it came from. */
export function resultTitle(day: Day, entry: DeliveryEntry): string {
	const subject = entry.subject;
	return (
		entry.title ??
		entry.snapshot?.title ??
		titleOf(
			entry.key,
			subject,
			subject.kind === "task" ? missions(day).find((m) => m.id === subject.missionId)?.title : undefined,
		)
	);
}

/** Where a result came from: its mission's title, or a standalone chat. */
export function resultOrigin(day: Day, entry: DeliveryEntry): string {
	const subject = entry.subject;
	return subject.kind === "task"
		? (missions(day).find((m) => m.id === subject.missionId)?.title ?? "A mission")
		: "Standalone chat";
}

function LiveToCheck(props: {
	day: Day;
	mirror: DeliveryMirror;
	missionId?: string;
	nested?: boolean;
	queued?: boolean;
}) {
	const v = () => props.mirror.view();
	// Each time Today shows, look again. Passive: it reads saved commands and results only.
	void props.mirror.source.readSaved();
	const missionTitle = (id: string) => missions(props.day).find((m) => m.id === id)?.title;
	const title = (op: { key: string; subject: DeliveryOp["subject"] }) =>
		v().entries[op.key]?.title ??
		v().entries[op.key]?.snapshot?.title ??
		titleOf(op.key, op.subject, op.subject.kind === "task" ? missionTitle(op.subject.missionId) : undefined);
	// Queued, the results are Needs you's cards: only notes, unconfirmed checks and paging show here.
	const rows = (): DeliveryEntry[] => (props.queued ? [] : checkRows(v(), props.missionId));
	const unsettled = () => v().unsettled.filter((o) => inMission(o.subject, props.missionId));
	// Discovery pages through all of Today's results; a mission page shows what was found.
	const discovery = () => (props.missionId ? undefined : v().discovery);
	const notes = () =>
		v()
			.settled.filter((op) => inMission(op.subject, props.missionId))
			.map((op) => ({ id: op.operationId, text: settledLine(op, title(op)) }))
			.slice(-3);
	const message = signal("");
	const visible = () =>
		rows().length + unsettled().length + notes().length > 0 ||
		v().saved === "unavailable" ||
		!!message() ||
		!!discovery()?.reason ||
		!!discovery()?.more;
	const origin = (subject: DeliveryOp["subject"]) =>
		props.missionId
			? ""
			: subject.kind === "task"
				? (missionTitle(subject.missionId) ?? "A mission")
				: "Standalone chat";
	const meta = (key: string) => {
		const e = v().entries[key];
		if (!e?.snapshot) return "";
		const merged = ownPullRequests(e.snapshot).some((r) => r.pullRequest?.state === "merged");
		return [origin(e.subject), merged ? "PR merged · release not tracked" : ""].filter(Boolean).join(" · ");
	};
	return (
		<If when={visible()}>
			{/* On its own (a mission's page) it is a section; nested in Today's queue it is a group of rows. */}
			<If
				when={!props.nested && !props.queued}
				else={
					<View testID="to-check">
						<If when={props.nested && !props.queued}>
							<RowGroup label={rows().length > 0 ? `To check · ${rows().length}` : "To check"} />
						</If>
						{body()}
					</View>
				}
			>
				<Section testID="to-check" title="To check" count={rows().length}>
					{body()}
				</Section>
			</If>
		</If>
	);
	function body() {
		return (
			<>
				<If when={discovery()?.reason}>
					<EmptyLine text={discovery()?.reason ?? ""} />
				</If>
				<If when={discovery()?.more}>
					<Block>
						<Link
							label="Next results"
							testID="check-more"
							onPress={() => void props.mirror.source.readMore?.()}
						/>
					</Block>
				</If>
				<If when={discovery()?.later}>
					<Block>
						<Link
							label="First results"
							testID="check-first"
							onPress={() => void props.mirror.source.readSaved()}
						/>
					</Block>
				</If>
				<If when={v().saved === "unavailable"}>
					<Notice
						placement="section"
						text="Pilot could not read your earlier checks. This is not the same as having none."
					/>
				</If>
				<Each of={unsettled()} key={(o) => o.operationId}>
					{(o) => (
						// One saved command whose answer is lost, and its read-only Check.
						<Notice
							testID={`check-unsettled-${o().operationId}`}
							placement="section"
							text={unsettledLine(o(), title(o()))}
							detail="Pilot will not send it again. Check only reads its saved answer."
							action={
								<Link
									label={o().checking ? "Checking…" : "Check"}
									testID={`check-op-${o().operationId}`}
									accessibilityLabel="Check whether it happened. This reads Pilot's saved answer and sends nothing."
									disabled={o().checking}
									onPress={() => {
										message.set("");
										void props.mirror.source.check(o().operationId).then((r) => {
											if (r.status !== "accepted") message.set(r.message);
										});
									}}
								/>
							}
						/>
					)}
				</Each>
				<If when={message()}>
					<Block>
						<Body role="alert" tone="muted">
							{message()}
						</Body>
					</Block>
				</If>
				<Rows>
					<Each of={notes()} key={(n) => n.id}>
						{(n) => <Row mark="done" title={n().text} wrap />}
					</Each>
				</Rows>
				<Rows>
					<Each of={rows()} key={(e) => e.key}>
						{(e) => {
							const entry = e();
							const name = () => title(entry);
							const id = `check-${entry.key.replaceAll("/", ".")}`;
							const place = placeRow(id, () => {
								// Coming back keeps the mission page where it was.
								if (props.missionId)
									restoreScroll(`mission/${props.missionId}`, scrollOf(`mission/${props.missionId}`));
								openDelivery(entry.subject, name());
							});
							return (
								<Row
									testID={id}
									mark={e().snapshot?.pendingOperationId ? "unconfirmed" : "needs"}
									title={name()}
									meta={meta(entry.key)}
									state={e().snapshot?.pendingOperationId ? "Check not confirmed" : "To check"}
									stateTone="needs"
									accessibilityLabel={`${name()}, delivered. Open it to check the result.`}
									anchor={place.anchor}
									onPress={place.press}
								/>
							);
						}}
					</Each>
				</Rows>
			</>
		);
	}
}

/**
 * Delivered results waiting for the user's check: all of Today's, or one
 * mission's. Nested, it is part of Needs you and shows a small heading. Queued, Needs you shows the
 * results themselves as cards, and this keeps only notes, unconfirmed checks and paging.
 * Hidden when nothing waits; the mock window has no results and shows none.
 */
export function ToCheck(props: { day: Day; missionId?: string; nested?: boolean; queued?: boolean }) {
	const mirror = props.day.delivery;
	return (
		<If when={mirror}>
			<LiveToCheck
				day={props.day}
				mirror={mirror as DeliveryMirror}
				missionId={props.missionId}
				nested={props.nested}
				queued={props.queued}
			/>
		</If>
	);
}
