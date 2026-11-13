// One delivered result: the agent's report, its outputs, where it stands
// and the user's own check. The page reads the exact canonical result;
// only Mark done, Send back and Reopen send, each once, for exactly the
// result and revision shown. Opening a link, ticking a reminder or reading
// the page records nothing and is never the user's check. A press on a web
// link asks native to read the result again and hand exactly that address
// to the browser, once; nothing retries it. Ticked reminders are kept with
// the window only. A command whose answer is lost stays Unknown, with Check
// only, until its own receipt says how it ended.
// An artifact's pinned revision shows its saved source as plain text on a
// press of Inspect source, read once. NSH opens in the app's isolated native
// preview: the first pinned one on its own when the page opens, others on a
// press. Each output keeps its own view. A newer result or lost read hides
// them; looking records nothing.
import { effect, keymap, Scroll, signal, Text, untracked, View, type ViewRef } from "nsh";
import { Checkbox, Input } from "nsh/base";
import { ArtifactPreview } from "./ArtifactPreview";
import { artifactPreviewsAvailable } from "./bridge";
import type { Day } from "./day";
import { artifactSelection } from "./deliveryArtifact";
import {
	type ArtifactLink,
	type Assessment,
	type DeliveredWork,
	type DeliveryMirror,
	type DeliveryOp,
	linkUrl,
	type OutputLink,
	webLink,
} from "./deliveryFeed";
import {
	agentLine,
	artifactLine,
	backNotes,
	backOpen,
	checkLine,
	closeDelivery,
	type DeliveryPlace,
	deliveryMessages,
	doneAsk,
	dropInspections,
	hideArtifact,
	type Inspection,
	inspectArtifact,
	inspectionCurrent,
	inspectionOf,
	lastInspection,
	outputMessages,
	ownPullRequests,
	prName,
	prObservation,
	productionLine,
	prState,
	pullRequestLine,
	pullRequestOpen,
	reminderKey,
	reminders,
	setNote,
	setTicks,
	titleOf,
	unsettledLine,
} from "./deliveryView";
import { keepField, keepScroll } from "./kept";
import { glide } from "./motion";
import { SourcePanel } from "./SourcePanel";
import { Action, Mark, RowLink, SectionTitle } from "./ui";
import { setFor } from "./view";

/** The most UTF-8 bytes a Send back note holds. */
const NOTE_LIMIT = 8000;

/** UTF-8 bytes of `text`, without an encoder. */
function utf8(text: string): number {
	let n = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
	}
	return n;
}

/** One line of "Where this stands": what, then its state. */
function Stand(props: { label: string; value: string; testID: string; tone?: "needs" }) {
	return (
		<View class="flex-row gap-4 border-t border-border py-2.5">
			<Text class="w-28 text-sm text-muted-foreground">{props.label}</Text>
			<Text
				testID={props.testID}
				class="flex-1 text-sm"
				classList={{ "text-foreground": props.tone !== "needs", "text-needs-ink": props.tone === "needs" }}
			>
				{props.value}
			</Text>
		</View>
	);
}

/** A labelled paragraph of the agent's account. */
function Said(props: { label: string; text: string }) {
	return (
		<If when={props.text.trim()}>
			<View class="gap-0.5">
				<Text class="text-xs text-faint">{props.label}</Text>
				<Text class="text-sm leading-relaxed text-foreground">{props.text}</Text>
			</View>
		</If>
	);
}

/** The agent's account of the result. Its words, never Pilot's check. */
function Report(props: { work: DeliveredWork }) {
	const w = () => props.work;
	const refs = () =>
		(w().nonCodeDelivery?.references ?? [])
			.map((r) => (r.kind === "brief" ? `Brief, revision ${r.revision}` : `Artifact, revision ${r.revision}`))
			.join(" · ");
	const nothing = () => !w().completion && !w().nonCodeDelivery && !w().submission && !w().outcome;
	return (
		<View testID="delivery-report" selectable class="gap-3 rounded-xl bg-muted px-4 py-4">
			<Text class="text-xs text-faint">The agent reports</Text>
			<If when={w().completion}>
				<Text class="text-xs text-faint">
					The commit and checks below are agent-reported. Publication is not independently verified here.
				</Text>
				<Said label="Checks it ran" text={w().completion?.checks ?? ""} />
				<Said label="Open issues" text={w().completion?.issues ?? ""} />
			</If>
			<If when={w().nonCodeDelivery}>
				<Said label="Checks it ran" text={w().nonCodeDelivery?.checks ?? ""} />
				<Said label="Limits" text={w().nonCodeDelivery?.limitations ?? ""} />
				<Said label="It points to" text={refs()} />
			</If>
			<If when={w().submission}>
				<Said label="It says" text={w().submission?.claim ?? ""} />
				<Said label="Limits" text={w().submission?.limitations ?? ""} />
			</If>
			<If when={w().outcome}>
				<Said label="It says" text={w().outcome?.reason || "The chat says it is done."} />
			</If>
			<If when={nothing()}>
				<Text class="text-sm text-muted-foreground">No report with this result.</Text>
			</If>
			<Text class="text-xs text-faint">This is the agent's account. It is not done until you say so.</Text>
		</View>
	);
}

/** A pull request's short name, such as "PR #12". */
function shortName(r: OutputLink): string {
	return prName(r).split(" · ")[0];
}

/** One artifact the agent linked: its title, kind and pinned revision, and Inspect source when it has a pin. */
function ArtifactOutput(props: {
	mirror: DeliveryMirror;
	place: DeliveryPlace;
	work: DeliveredWork;
	link: ArtifactLink;
	fresh: boolean;
	anchors: Map<string, ViewRef>;
}) {
	const key = () => props.place.key;
	const pinned = () => !!artifactSelection(props.work, props.link);
	const mine = () => (props.fresh ? inspectionOf(key(), props.work, props.link) : null);
	const reading = () => mine()?.state === "reading";
	const name = () => props.link.title || "the artifact";
	let sourceAnchor: ViewRef | undefined;
	let previewAnchor: ViewRef | undefined;
	return (
		<View class="gap-2 border-t border-border py-2.5">
			<View class="flex-row items-center gap-3">
				<Text class="flex-1 text-sm text-foreground">{props.link.title || "Artifact"}</Text>
				<Text class="text-xs text-muted-foreground">{artifactLine(props.link)}</Text>
				<If
					when={pinned()}
					else={
						<Text class="text-xs text-faint">
							{props.work.subject.kind === "task" ? "No pinned revision" : "No source here"}
						</Text>
					}
				>
					<Action
						label={reading() ? "Reading…" : mine() && !mine()?.preview ? "Hide source" : "Inspect source"}
						testID={`output-source-${props.link.artifactId}`}
						accessibilityLabel={
							mine() && !mine()?.preview
								? `Hide the source of ${name()}.`
								: `Show the saved source of ${name()}, revision ${props.link.revision}, as plain text. Looking records nothing.`
						}
						disabled={reading() || !props.fresh}
						anchor={(node) => {
							sourceAnchor = node;
							props.anchors.set(props.link.artifactId, node);
						}}
						onPress={() => {
							if (sourceAnchor) props.anchors.set(props.link.artifactId, sourceAnchor);
							if (mine() && !mine()?.preview) {
								glide();
								hideArtifact(key(), props.link);
							} else void inspectArtifact(props.mirror.source, key(), props.work, props.link);
						}}
					/>
					<If when={props.link.kind === "nsh" && artifactPreviewsAvailable()}>
						<Action
							label={mine()?.preview ? "Hide preview" : "Preview"}
							testID={`output-preview-${props.link.artifactId}`}
							disabled={reading() || !props.fresh}
							anchor={(node) => {
								previewAnchor = node;
							}}
							onPress={() => {
								if (previewAnchor) props.anchors.set(props.link.artifactId, previewAnchor);
								if (mine()?.preview) {
									glide();
									hideArtifact(key(), props.link);
								} else void inspectArtifact(props.mirror.source, key(), props.work, props.link, "preview");
							}}
						/>
					</If>
				</If>
			</View>
			<If when={mine()}>
				<If when={mine()?.preview} else={<SourcePanel inspection={mine() as Inspection} />}>
					<ArtifactPreview inspection={mine() as Inspection} />
				</If>
			</If>
		</View>
	);
}

/**
 * What the agent linked and saved. A web link opens in the browser on a
 * press, when this window can open links. An artifact's pinned revision
 * shows its saved source as plain text on a press. Neither records anything.
 */
function Outputs(props: {
	mirror: DeliveryMirror;
	place: DeliveryPlace;
	work: DeliveredWork;
	fresh: boolean;
	anchors: Map<string, ViewRef>;
}) {
	const w = () => props.work;
	const key = () => props.place.key;
	const count = () => w().pullRequests.length + w().artifacts.length + (w().completion ? 1 : 0);
	const web = () => props.mirror.view().webLinks;
	const opening = (r: OutputLink) => props.mirror.view().opening.includes(`${key()}#${r.id}`);
	const say = (m: string) => setFor(outputMessages, key(), m);
	const open = (r: OutputLink) => {
		say("");
		void props.mirror.source.open(w(), r).then((result) => {
			if (result.status === "opened") say(`Sent ${shortName(r)} to your browser. Nothing was recorded.`);
			else if (result.message) say(result.message);
		});
	};
	return (
		<View testID="delivery-outputs" class="gap-1">
			<View class="pb-1">
				<SectionTitle title="Outputs" count={count()} />
			</View>
			<If when={count() === 0}>
				<Text class="text-sm text-muted-foreground">The agent linked no outputs to this result.</Text>
			</If>
			<Each of={w().pullRequests} key={(r) => r.id}>
				{(r) => (
					<View selectable class="gap-0.5 border-t border-border py-2.5">
						<If
							when={web() && webLink(r())}
							else={
								<View class="flex-row items-baseline gap-3">
									<Text class="flex-1 text-sm text-foreground">{prName(r())}</Text>
									<Text class="text-xs text-muted-foreground">{prState(r())}</Text>
								</View>
							}
						>
							<RowLink
								testID={`output-open-${r().id}`}
								title={prName(r())}
								accessibilityLabel={`Open ${shortName(r())} in your browser. Opening it records nothing.`}
								onPress={() => open(r())}
							>
								<Text class="text-xs text-muted-foreground">{prState(r())}</Text>
								<Text class="w-16 text-right text-xs text-faint">{opening(r()) ? "Opening…" : "Open ↗"}</Text>
							</RowLink>
						</If>
						<Text class="text-xs text-faint">{linkUrl(r())}</Text>
						<If when={r().kind === "github.pr"}>
							<Text class="text-xs text-faint">{prObservation(r())}</Text>
						</If>
					</View>
				)}
			</Each>
			<Each of={w().artifacts} key={(a) => `${a.sessionId}/${a.artifactId}`}>
				{(a) => (
					<ArtifactOutput
						mirror={props.mirror}
						place={props.place}
						work={w()}
						link={a()}
						fresh={props.fresh}
						anchors={props.anchors}
					/>
				)}
			</Each>
			<If when={w().completion}>
				<View class="flex-row items-baseline gap-3 border-t border-border py-2.5">
					<Text class="flex-1 text-sm text-foreground">{`Commit ${w().completion?.commit.slice(0, 12) ?? ""}`}</Text>
					<Text class="text-xs text-muted-foreground">Source, as the agent recorded it</Text>
				</View>
			</If>
			<If when={outputMessages()[key()]}>
				<Text role="alert" testID="output-message" class="pt-1 text-sm text-muted-foreground">
					{outputMessages()[key()] ?? ""}
				</Text>
			</If>
			<If when={w().pullRequests.length > 0}>
				<Text class="pt-1 text-xs text-faint">
					{web()
						? "Opening a link shows it in your browser. It records nothing; only Mark done is your check."
						: "Pilot cannot open links in this window. Copy one; opening it records nothing."}
				</Text>
			</If>
			<If when={w().artifacts.length > 0}>
				<Text class="text-xs text-faint">
					Inspect source shows the saved text of a pinned revision. NSH previews run apart from Pilot and change
					only their own state. Looking records nothing.
				</Text>
			</If>
		</View>
	);
}

/** The four lines: the agent, the pull request, production and the user's check. Never one merged state. */
function Stands(props: { work: DeliveredWork; unsettled: DeliveryOp | undefined }) {
	const merged = () => ownPullRequests(props.work).some((r) => r.pullRequest?.state === "merged");
	return (
		<View testID="delivery-stands" class="gap-0">
			<View class="pb-2">
				<SectionTitle title="Where this stands" />
			</View>
			<Stand label="Agent" testID="stand-agent" value={agentLine(props.work)} />
			<Stand label="Pull request" testID="stand-pr" value={pullRequestLine(props.work)} />
			<Stand
				label="Production"
				testID="stand-production"
				value={productionLine(props.work)}
				tone={merged() ? "needs" : undefined}
			/>
			<Stand label="Your check" testID="stand-check" value={checkLine(props.work, props.unsettled)} />
		</View>
	);
}

/** Reminders for the user's own look. Ticking one sends nothing; the window keeps the ticks. */
function Reminders(props: { place: DeliveryPlace; work: DeliveredWork }) {
	const id = () => reminderKey(props.place.key, props.work.deliveryId ?? "");
	const items = () => {
		const out = [{ id: "report", label: "Read the agent's report" }];
		for (const r of ownPullRequests(props.work).slice(0, 3)) {
			out.push({ id: `pr-${r.id}`, label: `Looked at ${prName(r).split(" · ")[0]}` });
		}
		const art = props.work.artifacts[0];
		if (art) out.push({ id: `art-${art.artifactId}`, label: `Looked at ${art.title || "the artifact"}` });
		return out;
	};
	const ticked = () => reminders()[id()] ?? [];
	return (
		<View class="gap-0.5">
			<Each of={items()} key={(i) => i.id}>
				{(i) => (
					<Checkbox
						testID={`reminder-${i().id}`}
						checked={ticked().includes(i().id)}
						onChange={() =>
							setTicks(
								id(),
								ticked().includes(i().id) ? ticked().filter((x) => x !== i().id) : [...ticked(), i().id],
							)
						}
						class="flex-row items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
						indicatorClass="size-4 items-center justify-center rounded border border-input checked:border-primary checked:bg-primary"
						indicator={
							<If when={ticked().includes(i().id)}>
								<View testID={`reminder-ticked-${i().id}`} class="size-2 rounded-sm bg-primary-foreground" />
							</If>
						}
					>
						<Text class="text-sm text-foreground">{i().label}</Text>
					</Checkbox>
				)}
			</Each>
		</View>
	);
}

/** The user's own check: reminders, Mark done and Send back, or how the last check ended. */
function YourCheck(props: { mirror: DeliveryMirror; place: DeliveryPlace; work: DeliveredWork; title: string }) {
	const key = () => props.place.key;
	const w = () => props.work;
	const v = () => props.mirror.view();
	const unsettled = () => v().unsettled.find((o) => o.key === key());
	const sending = () => v().sending.includes(key());
	const note = () => backNotes()[key()] ?? "";
	const open = () => backOpen()[key()] === true;
	const say = (m: string) => setFor(deliveryMessages, key(), m);
	const shownState = () => (w().verificationCurrent ? w().verification?.state : undefined);
	const asked = () => {
		const a = doneAsk();
		return a && a.key === key() ? a : null;
	};
	// The Done asked about is the one sent: a newer result closes it instead.
	const askedCurrent = () => {
		const a = asked();
		return !!a && a.deliveryId === w().deliveryId && a.revision === w().verificationRevision;
	};
	const tooLong = () => utf8(note()) > NOTE_LIMIT;
	const field = keepField(`note:${key()}`, () => `delivery/${key()}`, note);

	const send = async (action: Assessment) => {
		const shown = w();
		if (sending() || !shown.deliveryId) return;
		const words = action === "send_back" ? note() : "";
		say("");
		doneAsk.set(null);
		const r = await props.mirror.source.assess(shown, action, words);
		if (r.status === "accepted") {
			if (action === "send_back" && backNotes()[key()] === words) {
				setNote(key(), "");
				setFor(backOpen, key(), false);
			}
			return;
		}
		say(r.message);
	};
	const markDone = () => {
		const shown = w();
		if (!shown.deliveryId) return;
		if (pullRequestOpen(shown)) {
			glide();
			doneAsk.set({ key: key(), deliveryId: shown.deliveryId, revision: shown.verificationRevision });
			return;
		}
		void send("done");
	};
	const openPrs = () =>
		ownPullRequests(w())
			.filter((r) => r.pullRequest?.state !== "merged")
			.map((r) => prName(r).split(" · ")[0]);
	return (
		<View testID="your-check" class="gap-3 rounded-xl border border-border px-4 py-4">
			<Text role="header" class="text-base font-semibold text-foreground">
				Your check
			</Text>
			<If when={unsettled()}>
				<View testID="delivery-unknown" class="gap-1.5 rounded-xl bg-muted px-4 py-3">
					<View class="flex-row items-center gap-2.5">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">
							{unsettled() ? unsettledLine(unsettled() as DeliveryOp, props.title) : ""}
						</Text>
						<Action
							label={unsettled()?.checking ? "Checking…" : "Check"}
							testID="delivery-check"
							accessibilityLabel="Check whether it happened. This reads Pilot's saved answer and sends nothing."
							disabled={unsettled()?.checking === true}
							onPress={() => {
								const op = unsettled();
								if (!op) return;
								say("");
								void props.mirror.source.check(op.operationId).then((r) => {
									if (r.status !== "accepted") say(r.message);
								});
							}}
						/>
					</View>
					<If when={unsettled()?.note}>
						<Text class="text-sm text-muted-foreground">{`Your note: ${unsettled()?.note ?? ""}`}</Text>
					</If>
					<Text class="text-xs text-faint">Pilot will not send it again. Check only reads its saved answer.</Text>
				</View>
			</If>
			<If when={!unsettled() && !!w().pendingOperationId}>
				<Text class="text-sm text-muted-foreground">
					An earlier check of this result is waiting for Pilot to confirm it. Nothing can be sent until then.
				</Text>
			</If>
			<If when={!unsettled() && !w().pendingOperationId && !w().deliveryId}>
				<Text class="text-sm text-muted-foreground">
					There is nothing to check yet. The agent has not delivered a result Pilot can show.
				</Text>
			</If>
			<If when={!unsettled() && !w().pendingOperationId && shownState() === "done"}>
				<View testID="delivery-done" class="gap-2">
					<Text class="text-sm text-foreground">
						You marked this done. That means you accept the result. It does not merge, release or reply to anyone.
					</Text>
					<View class="flex-row">
						<Action
							label="Reopen"
							testID="delivery-reopen"
							disabled={sending()}
							onPress={() => void send("reopen")}
						/>
					</View>
				</View>
			</If>
			<If when={!unsettled() && !w().pendingOperationId && shownState() === "sent_back"}>
				<View testID="delivery-sent-back" class="gap-2">
					<Text class="text-sm text-foreground">
						You sent this back. The agent has your note; its next result shows on Today to check.
					</Text>
					<Text class="text-sm text-muted-foreground">{w().verification?.note ?? ""}</Text>
					<View class="flex-row">
						<Action
							label="Reopen"
							testID="delivery-reopen"
							disabled={sending()}
							onPress={() => void send("reopen")}
						/>
					</View>
				</View>
			</If>
			<If
				when={
					!unsettled() &&
					!w().pendingOperationId &&
					!!w().deliveryId &&
					shownState() !== "done" &&
					shownState() !== "sent_back"
				}
			>
				<View class="gap-3">
					<Text class="text-xs text-faint">
						Reminders only. Ticks send nothing and stay with this window; you decide when it is done.
					</Text>
					<Reminders place={props.place} work={w()} />
					<If when={open()}>
						<View class="gap-1.5">
							<Input
								testID="send-back-note"
								ref={field.ref}
								accessibilityLabel="What should change. The agent gets this note."
								multiline
								autoFocus
								value={note()}
								onChange={({ value }) => setNote(key(), value)}
								onFocus={field.focus}
								onSelectionChange={field.select}
								placeholder="What should change? The agent gets this note."
								class="min-h-20 rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary"
							/>
							<If when={tooLong()}>
								<Text class="text-xs text-needs-ink">This note is too long to send. Shorten it first.</Text>
							</If>
							<Text class="text-xs text-faint">
								Pilot sends it once, as a message to the agent that did the work. Nothing else starts.
							</Text>
							<View class="flex-row gap-2">
								<Action
									primary
									label={sending() ? "Sending…" : "Send back"}
									testID="send-back"
									disabled={sending() || note().trim() === "" || tooLong()}
									onPress={() => void send("send_back")}
								/>
								<Action
									label="Cancel"
									testID="send-back-cancel"
									disabled={sending()}
									onPress={() => {
										glide();
										setFor(backOpen, key(), false);
									}}
								/>
							</View>
						</View>
					</If>
					<If when={asked()}>
						<View testID="done-confirm" class="gap-2 rounded-xl bg-muted px-4 py-3">
							<Text class="text-sm text-foreground">
								{`${openPrs().join(", ") || "Its pull request"} ${openPrs().length > 1 ? "are" : "is"} not merged. Done means you accept the result now. Pilot won't merge it, and it won't count as released.`}
							</Text>
							<If when={!askedCurrent()}>
								<Text class="text-xs text-needs-ink">
									This result changed since you asked. Cancel and look again.
								</Text>
							</If>
							<View class="flex-row gap-2">
								<Action
									primary
									label={sending() ? "Sending…" : "Mark done anyway"}
									testID="done-anyway"
									disabled={sending() || !askedCurrent()}
									onPress={() => void send("done")}
								/>
								<Action
									label="Cancel"
									testID="done-cancel"
									disabled={sending()}
									onPress={() => doneAsk.set(null)}
								/>
							</View>
						</View>
					</If>
					<If when={!open() && !asked()}>
						<View class="flex-row flex-wrap gap-2">
							<Action
								primary
								label={sending() ? "Sending…" : "Mark done"}
								testID="mark-done"
								disabled={sending()}
								onPress={markDone}
							/>
							<Action
								label="Send back…"
								testID="send-back-open"
								disabled={sending()}
								onPress={() => {
									glide();
									setFor(backOpen, key(), true);
								}}
							/>
						</View>
					</If>
					<If when={!open() && note()}>
						<Text class="text-xs text-faint">Your unsent note is kept. Send back… shows it again.</Text>
					</If>
				</View>
			</If>
			<If when={deliveryMessages()[key()]}>
				<Text role="alert" testID="delivery-message" class="text-sm text-needs-ink">
					{deliveryMessages()[key()] ?? ""}
				</Text>
			</If>
		</View>
	);
}

/**
 * The page of one delivered result, over Today or a mission. Opening it
 * reads the result; that read sends, settles and records nothing.
 */
export function DeliveryScreen(props: { day: Day; place: DeliveryPlace }) {
	const mirror = props.day.delivery as DeliveryMirror;
	const key = props.place.key;
	const entry = () => mirror.view().entries[key];
	const work = () => entry()?.snapshot ?? null;
	const reading = signal(true);
	void mirror.source.read(props.place.subject).then(() => reading.set(false));
	const missionTitle = () => {
		const s = props.place.subject;
		if (s.kind !== "task") return undefined;
		const t = props.day.today();
		return [...t.moving, ...t.notMoving, ...t.unreported].find((m) => m.id === s.missionId)?.title;
	};
	const title = () => props.place.title || titleOf(key, props.place.subject, missionTitle());
	const origin = () =>
		props.place.subject.kind === "task" ? `A task in ${missionTitle() ?? "a mission"}` : "A standalone chat";
	const fresh = () => !!work() && !entry()?.reason;
	// A shown source or preview is only for the exact pin of the result as last
	// read. A newer result, a changed pin or a failed read drops it at once.
	effect(() => {
		const w = work();
		const ok = fresh();
		untracked(() => dropInspections(key, (i) => !!w && ok && inspectionCurrent(i, key, w)));
	});
	// The first pinned NSH output opens in its preview once per delivery: Hide
	// keeps it closed, and a newer delivery opens its own. The sandbox, not a
	// press, is the safety boundary. Others open on a press.
	let previewed = "";
	effect(() => {
		const w = work();
		if (!w?.deliveryId || !fresh() || !artifactPreviewsAvailable() || w.deliveryId === previewed) return;
		previewed = w.deliveryId;
		const first = w.artifacts.find((a) => a.kind === "nsh" && artifactSelection(w, a));
		if (first) untracked(() => void inspectArtifact(mirror.source, key, w, first, "preview"));
	});
	const anchors = new Map<string, ViewRef>();
	// Escape works from the note too: the note closes first and keeps its words,
	// then the source or preview opened last, then the page.
	keymap.bind(
		"escape",
		() => {
			const last = lastInspection(key);
			if (doneAsk()?.key === key) doneAsk.set(null);
			else if (backOpen()[key]) {
				glide();
				setFor(backOpen, key, false);
			} else if (last) {
				glide();
				hideArtifact(key, { sessionId: last.pin.sourceSessionId, artifactId: last.pin.artifactId });
				anchors.get(last.pin.artifactId)?.focus();
			} else closeDelivery();
		},
		{ when: "always" },
	);
	const scroll = keepScroll(`delivery/${key}`);
	const unsettled = () => mirror.view().unsettled.find((o) => o.key === key);
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View testID="delivery" class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<View class="gap-2">
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						{title()}
					</Text>
					<Text class="text-sm text-muted-foreground">{origin()}</Text>
				</View>
				<If when={entry()?.reason}>
					<View testID="delivery-off" class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">{entry()?.reason ?? ""}</Text>
					</View>
				</If>
				<If
					when={work()}
					else={
						<Text class="text-base text-muted-foreground">
							{reading() && !entry()?.reason ? "Reading this result…" : "Pilot cannot show this result now."}
						</Text>
					}
				>
					<Each of={work() ? [work() as DeliveredWork] : []} key={(w) => w.deliveryId ?? "none"}>
						{(w) => (
							<View class="gap-10">
								<Report work={w()} />
								<Outputs mirror={mirror} place={props.place} work={w()} fresh={fresh()} anchors={anchors} />
								<Stands work={w()} unsettled={unsettled()} />
								<YourCheck mirror={mirror} place={props.place} work={w()} title={title()} />
							</View>
						)}
					</Each>
				</If>
			</View>
		</Scroll>
	);
}
