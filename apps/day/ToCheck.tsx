// Today's To check: delivered results that wait for the user's own check,
// and the user's Done, Send back or Reopen whose answer is not known.
// Pilot also reads new canonical deliveries after the saved start-fresh cutoff.
// Earlier checks and acknowledged standalone starts are kept. Nothing here sends,
// and an agent's report or a merged pull request never counts as a check.
import { signal, Text, View } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type { Day } from "./day";
import type { DeliveryEntry, DeliveryMirror, DeliveryOp, DeliveryView } from "./deliveryFeed";
import { openDelivery, ownPullRequests, settledLine, titleOf, unsettledLine, waitsForCheck } from "./deliveryView";
import { restoreScroll, scrollOf } from "./kept";
import { Action, Mark, RowLink, SectionTitle } from "./ui";
import { placeRow } from "./view";

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
		);
}

/** How many results and unconfirmed checks wait for the user. Needs you counts them. */
export function toCheckCount(day: Day): number {
	const v = day.delivery?.view();
	return v ? checkRows(v).length + v.unsettled.length : 0;
}

/** One saved command whose answer is lost, and its read-only Check. */
function Unsettled(props: { mirror: DeliveryMirror; op: DeliveryOp; title: string; onResult: (m: string) => void }) {
	return (
		<View testID={`check-unsettled-${props.op.operationId}`} class="gap-1.5 rounded-xl bg-muted px-4 py-3">
			<View class="flex-row items-center gap-2.5">
				<Mark kind="unknown" />
				<Text class="flex-1 text-sm text-foreground">{unsettledLine(props.op, props.title)}</Text>
				<Action
					label={props.op.checking ? "Checking…" : "Check"}
					testID={`check-op-${props.op.operationId}`}
					accessibilityLabel="Check whether it happened. This reads Pilot's saved answer and sends nothing."
					disabled={props.op.checking}
					onPress={() => {
						props.onResult("");
						void props.mirror.source.check(props.op.operationId).then((r) => {
							if (r.status !== "accepted") props.onResult(r.message);
						});
					}}
				/>
			</View>
			<Text class="text-xs text-faint">Pilot will not send it again. Check only reads its saved answer.</Text>
		</View>
	);
}

function LiveToCheck(props: { day: Day; mirror: DeliveryMirror; missionId?: string; nested?: boolean }) {
	const v = () => props.mirror.view();
	// Each time Today shows, look again. Passive: it reads saved commands and results only.
	void props.mirror.source.readSaved();
	const missionTitle = (id: string) => missions(props.day).find((m) => m.id === id)?.title;
	const title = (op: { key: string; subject: DeliveryOp["subject"] }) =>
		v().entries[op.key]?.title ??
		v().entries[op.key]?.snapshot?.title ??
		titleOf(op.key, op.subject, op.subject.kind === "task" ? missionTitle(op.subject.missionId) : undefined);
	const rows = (): DeliveryEntry[] => checkRows(v(), props.missionId);
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
			<View testID="to-check" class="gap-1">
				<If
					when={props.nested}
					else={
						<View class="pb-1">
							<SectionTitle title="To check" count={rows().length} />
						</View>
					}
				>
					<Text role="header" class="pb-0.5 text-xs font-medium text-muted-foreground">
						{rows().length > 0 ? `To check · ${rows().length}` : "To check"}
					</Text>
				</If>
				<If when={discovery()?.reason}>
					<Text class="text-xs text-muted-foreground">{discovery()?.reason ?? ""}</Text>
				</If>
				<If when={discovery()?.more}>
					<Action label="Next results" testID="check-more" onPress={() => void props.mirror.source.readMore?.()} />
				</If>
				<If when={discovery()?.later}>
					<Action
						label="First results"
						testID="check-first"
						onPress={() => void props.mirror.source.readSaved()}
					/>
				</If>
				<If when={v().saved === "unavailable"}>
					<View class="mb-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">
							Pilot could not read your earlier checks. This is not the same as having none.
						</Text>
					</View>
				</If>
				<Each of={unsettled()} key={(o) => o.operationId}>
					{(o) => (
						<View class="mb-2">
							<Unsettled mirror={props.mirror} op={o()} title={title(o())} onResult={(m) => message.set(m)} />
						</View>
					)}
				</Each>
				<If when={message()}>
					<Text role="alert" class="pb-1 text-sm text-muted-foreground">
						{message()}
					</Text>
				</If>
				<Each of={notes()} key={(n) => n.id}>
					{(n) => (
						<View class="flex-row items-center gap-2.5 pb-1">
							<Mark kind="done" />
							<Text class="flex-1 text-sm text-muted-foreground">{n().text}</Text>
						</View>
					)}
				</Each>
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
							<View class="gap-1 border-t border-border py-3.5">
								<RowLink
									testID={id}
									title={name()}
									accessibilityLabel={`${name()}, delivered. Open it to check the result.`}
									anchor={place.anchor}
									onPress={place.press}
								>
									<View class="flex-row items-center gap-1.5">
										<Mark kind={e().snapshot?.pendingOperationId ? "unknown" : "needs"} />
										<Text class="text-xs text-needs-ink">
											{e().snapshot?.pendingOperationId ? "Check not confirmed" : "To check"}
										</Text>
									</View>
								</RowLink>
								<Text class="text-xs text-faint">{meta(entry.key)}</Text>
							</View>
						);
					}}
				</Each>
			</View>
		</If>
	);
}

/**
 * Delivered results waiting for the user's check: all of Today's, or one
 * mission's. Nested, it is part of Needs you and shows a small heading.
 * Hidden when nothing waits; the mock window has no results and shows none.
 */
export function ToCheck(props: { day: Day; missionId?: string; nested?: boolean }) {
	const mirror = props.day.delivery;
	return (
		<If when={mirror}>
			<LiveToCheck
				day={props.day}
				mirror={mirror as DeliveryMirror}
				missionId={props.missionId}
				nested={props.nested}
			/>
		</If>
	);
}
