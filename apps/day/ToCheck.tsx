// Today's To check: delivered results that wait for the user's own check,
// and the user's Done, Send back or Reopen whose answer is not known.
// Pilot looks at the results the user checked before and the requests they
// started as standalone chats. Opening a row reads it; nothing here sends,
// and an agent's report or a merged pull request never counts as a check.
import { signal, Text, View } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type { Day } from "./day";
import type { DeliveryEntry, DeliveryMirror, DeliveryOp } from "./deliveryFeed";
import { openDelivery, ownPullRequests, settledLine, titleOf, unsettledLine, waitsForCheck } from "./deliveryView";
import { Action, Mark, RowLink, SectionTitle } from "./ui";
import { placeRow } from "./view";

function missions(day: Day): MissionRow[] {
	const t = day.today();
	return [...t.moving, ...t.notMoving, ...t.unreported];
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

function LiveToCheck(props: { day: Day; mirror: DeliveryMirror }) {
	const v = () => props.mirror.view();
	// Each time Today shows, look again. Passive: it reads saved commands and results only.
	void props.mirror.source.readSaved();
	const missionTitle = (id: string) => missions(props.day).find((m) => m.id === id)?.title;
	const title = (op: { key: string; subject: DeliveryOp["subject"] }) =>
		titleOf(op.key, op.subject, op.subject.kind === "task" ? missionTitle(op.subject.missionId) : undefined);
	const rows = (): DeliveryEntry[] =>
		v()
			.candidates.map((key) => v().entries[key])
			.filter(
				(e): e is DeliveryEntry =>
					!!e &&
					waitsForCheck(
						e.snapshot,
						v().unsettled.find((o) => o.key === e.key),
					) &&
					!v().sending.includes(e.key),
			);
	const notes = () =>
		v()
			.settled.map((op) => ({ id: op.operationId, text: settledLine(op, title(op)) }))
			.slice(-3);
	const message = signal("");
	const visible = () =>
		rows().length + v().unsettled.length + notes().length > 0 || v().saved === "unavailable" || !!message();
	const origin = (subject: DeliveryOp["subject"]) =>
		subject.kind === "task" ? (missionTitle(subject.missionId) ?? "A mission") : "Standalone chat";
	const meta = (key: string) => {
		const e = v().entries[key];
		if (!e?.snapshot) return "";
		const merged = ownPullRequests(e.snapshot).some((r) => r.pullRequest?.state === "merged");
		return [origin(e.subject), merged ? "PR merged · release not tracked" : ""].filter(Boolean).join(" · ");
	};
	return (
		<If when={visible()}>
			<View testID="to-check" class="gap-1">
				<View class="pb-1">
					<SectionTitle title="To check" count={rows().length} />
				</View>
				<If when={v().saved === "unavailable"}>
					<View class="mb-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">
							Pilot could not read your earlier checks. This is not the same as having none.
						</Text>
					</View>
				</If>
				<Each of={v().unsettled} key={(o) => o.operationId}>
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
						const place = placeRow(id, () => openDelivery(entry.subject, name()));
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
										<Mark kind="needs" />
										<Text class="text-xs text-needs-ink">To check</Text>
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
 * Delivered results waiting for the user's check. Hidden when nothing
 * waits; the mock window has no results and shows none.
 */
export function ToCheck(props: { day: Day }) {
	const mirror = props.day.delivery;
	return (
		<If when={mirror}>
			<LiveToCheck day={props.day} mirror={mirror as DeliveryMirror} />
		</If>
	);
}
