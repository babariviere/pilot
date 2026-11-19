// A delivered result as Needs you's card: what was delivered, its evidence, and one way to check it.
// Opening it reads; only Mark done or Send back on its page send anything. Later puts it after the
// other results in this window only.
import { cleanup, effect, Text, View, type ViewRef } from "nsh";
import type { Day } from "./day";
import type { DeliveredWork } from "./deliveryContract";
import type { DeliveryEntry } from "./deliveryFeed";
import { openDelivery, ownPullRequests, prName, prState } from "./deliveryView";
import { resultOrigin, resultTitle } from "./ToCheck";
import { Action, Mark, Panel } from "./ui";
import { anchors, focusFront, laterResult, placeRow } from "./view";

/** The key that takes the front card's one next action, as on the other cards. */
const OPEN_KEY = "⌘↩";

/** "40 min ago", "3 h ago", "2 d ago", or "" when the time is not known. */
function ago(at: number | undefined): string {
	if (!at || !Number.isFinite(at)) return "";
	const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
	if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The changes a result names: its pull request, else its commit, else that it changed no code. */
function changes(work: DeliveredWork): string {
	const prs = ownPullRequests(work);
	if (prs.length > 0) {
		const more = prs.length > 1 ? ` · ${prs.length - 1} more` : "";
		return `${prName(prs[0]!)} · ${prState(prs[0]!)}${more}`;
	}
	const commit = work.workerDelivery?.commit ?? work.completion?.commit;
	if (commit) return `Commit ${commit.slice(0, 7)}`;
	return work.nonCodeDelivery ? "No code changes" : "";
}

/** The worker's screens, in a few words. */
function screens(work: DeliveredWork): string {
	const s = work.screens;
	if (!s) return "";
	if ("none" in s) return `None: ${s.none}`;
	const n = s.pairs.length;
	return n === 1 ? "1 screen" : `${n} screens`;
}

function Fact(props: { label: string; children: string }) {
	return (
		<View class="flex-row gap-3">
			<Text class="w-20 text-xs text-faint">{props.label}</Text>
			<Text class="line-clamp-2 flex-1 text-sm text-foreground">{props.children}</Text>
		</View>
	);
}

/** Result `props.entry`, `props.index` of `props.count` waiting. */
export function ResultCard(props: { day: Day; entry: DeliveryEntry; index: number; count: number }) {
	const e = () => props.entry;
	const id = `result:${props.entry.key}`;
	const work = () => e().snapshot;
	const title = () => resultTitle(props.day, e());
	const summary = () => work()?.workerDelivery?.summary || work()?.chatReport?.answer || "";
	const facts = () =>
		work()
			? [
					{ label: "Changes", value: changes(work() as DeliveredWork) },
					{ label: "Screens", value: screens(work() as DeliveredWork) },
				].filter((f) => f.value)
			: [];
	const delivered = () => {
		const at = ago(work()?.workerDelivery?.reportedAt ?? work()?.screens?.reportedAt);
		return at ? `Delivered ${at}` : "";
	};
	const unconfirmed = () => !!work()?.pendingOperationId;
	const meta = () =>
		[resultOrigin(props.day, e()), delivered()]
			.filter(Boolean)
			.map((part) => `· ${part}`)
			.join(" ");
	// The same ID To check's rows had: Back from the result returns the focus here.
	const rowId = `check-${props.entry.key.replaceAll("/", ".")}`;
	const place = placeRow(rowId, () => openDelivery(props.entry.subject, title()));
	let openButton: ViewRef | undefined;
	anchors.set(id, () => openButton);
	cleanup(() => anchors.delete(id));
	effect(() => {
		if (focusFront() && openButton) {
			openButton.focus();
			focusFront.set(false);
		}
	});
	return (
		<View testID="result" class="gap-4 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<View class="gap-2">
				<Text role="header" class="text-xl font-semibold leading-snug text-card-foreground">
					{title()}
				</Text>
				<View class="flex-row flex-wrap items-center gap-1.5">
					<Mark kind={unconfirmed() ? "unknown" : "needs"} />
					<Text class="text-xs text-needs-ink">{unconfirmed() ? "Check not confirmed" : "To check"}</Text>
					<Text class="text-xs text-muted-foreground">{meta()}</Text>
					<View class="flex-1" />
					<If when={props.count > 1}>
						<Text class="text-xs text-faint">{`${props.index + 1} of ${props.count}`}</Text>
					</If>
				</View>
			</View>
			<If when={summary()}>
				<Text class="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{summary()}</Text>
			</If>
			<If when={facts().length > 0}>
				<Panel class="gap-2">
					<Each of={facts()} key={(f) => f.label}>
						{(f) => <Fact label={f().label}>{f().value}</Fact>}
					</Each>
				</Panel>
			</If>
			<If when={e().reason}>
				<Text class="text-xs text-muted-foreground">{e().reason}</Text>
			</If>
			<Text class="text-xs text-faint">
				Pilot does not count an agent's report or a merged pull request as your check.
			</Text>
			<View class="flex-row flex-wrap items-center gap-2">
				<Action
					variant="primary"
					label="Check the result"
					testID={rowId}
					shortcut={OPEN_KEY}
					anchor={(node) => {
						openButton = node;
						place.anchor(node);
					}}
					onPress={place.press}
				/>
				<Action label="Later" shortcut="L" testID="result-later" onPress={() => laterResult(e().key)} />
				<View class="flex-1" />
				<Text class="text-xs text-faint">{`${OPEN_KEY} Open · J K next`}</Text>
			</View>
		</View>
	);
}
