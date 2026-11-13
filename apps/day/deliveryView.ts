// State the delivered-result page owns, and its words. Keyed by the
// result's exact key, so it survives reads, new deliveries and hot updates.
// Unsent Send back notes are kept exactly as typed; a close or an update
// saves them in the window's SavedView, and a restored window shows them
// again without sending anything (updateView.ts).
import { signal } from "nsh";
import { MAX_PREVIEWS } from "./artifactReads";
import { type ArtifactSelection, artifactSelection, samePin } from "./deliveryArtifact";
import type { PublicationRecord } from "./deliveryBridge";
import type {
	AgentWork,
	ArtifactLink,
	CapturedArtifact,
	DeliveredWork,
	DeliveryOp,
	DeliverySource,
	VerificationSubject,
} from "./deliveryFeed";
import { deliveryKey, subjectOf, workOf } from "./deliveryFeed";
import { glide } from "./motion";

/** The result open on its page, and the title Pilot knows for it. */
export type DeliveryPlace = { key: string; subject: VerificationSubject; title: string };

/** The delivered result whose page is open, over Today or a mission. */
export const deliveryRoute = signal<DeliveryPlace | null>(null);
/** Titles Pilot knows for results, by key, from the pages that named them. */
export const deliveryTitles = signal<Record<string, string>>({});
/** Unsent Send back notes, exactly as typed, by result. */
export const backNotes = signal<Record<string, string>>({});
/** Whether the Send back note is open, by result. Closing it keeps the words. */
export const backOpen = signal<Record<string, boolean>>({});
/** The Done the user asked to confirm: the exact result and revision it was asked on. */
export const doneAsk = signal<{ key: string; deliveryId: string; revision: number } | null>(null);
/**
 * Reminders the user ticked, by "<result key>#<delivery>". They send nothing
 * and are never a check. A close or an update saves them with the window.
 */
export const reminders = signal<Record<string, string[]>>({});
/** The last message a command returned, by result. */
export const deliveryMessages = signal<Record<string, string>>({});
/** The last message a press on an output link returned, by result. */
export const outputMessages = signal<Record<string, string>>({});

/**
 * What one output row of a result's page shows: the saved source of one exact
 * artifact pin as inert text, or its isolated preview. Each row keeps its
 * own. It lives with the page: closing the page, a newer result, a lost read
 * or an update drops it, and a saved window never keeps it.
 */
export type Inspection = {
	key: string;
	pin: ArtifactSelection;
	kind: string;
	title: string;
	generation: number;
	state: "reading" | "shown" | "refused";
	preview?: boolean;
	artifact: CapturedArtifact | null;
	message: string;
};

/** What each output row shows, by `inspectionKey`. */
export const inspections = signal<Record<string, Inspection>>({});
let generations = 0;

/**
 * The Agent work disclosure of one result, while it is open. Opening it reads
 * once; closing it, a newer delivery or another page drops the read. A saved
 * window never keeps it.
 */
export type WorkRead = {
	deliveryId: string;
	generation: number;
	state: "reading" | "shown" | "refused";
	work: AgentWork | null;
	message: string;
};

/** Open Agent work disclosures, by result key. */
export const agentWork = signal<Record<string, WorkRead>>({});

/** Opens and reads the Agent work of the result shown. A press while it reads does nothing. */
export async function showWork(source: DeliverySource, key: string, shown: DeliveredWork) {
	if (!shown.deliveryId) return;
	const now = agentWork()[key];
	if (now && now.deliveryId === shown.deliveryId && now.state === "reading") return;
	const generation = ++generations;
	const reading: WorkRead = { deliveryId: shown.deliveryId, generation, state: "reading", work: null, message: "" };
	glide();
	agentWork.update((all) => ({ ...all, [key]: reading }));
	const r = await source.agentWork(shown);
	if (agentWork()[key]?.generation !== generation) return;
	agentWork.update((all) => ({
		...all,
		[key]:
			r.status === "shown" && workOf(r.work, shown)
				? { ...reading, state: "shown", work: r.work }
				: { ...reading, state: "refused", message: r.status === "refused" ? r.message : "" },
	}));
}

/** Closes one result's Agent work. An answer still on its way is not shown. */
export function hideWork(key: string) {
	if (!agentWork()[key]) return;
	agentWork.update((all) => {
		const next = { ...all };
		delete next[key];
		return next;
	});
}

/** Agent work to open with the next page of `key`, as a coordinator thread asks. */
export const workOnOpen = signal<string | null>(null);

/** One push or pull request attempt: what was saved before it ran and what its command returned. */
export type Attempt = {
	id: string;
	kind: "push" | "pr_opened";
	/** Saved before the command ran. Absent on older records. */
	dispatch: PublicationRecord | null;
	/** Saved after the command returned. Absent while unresolved. */
	result: PublicationRecord | null;
	/** An older record that kept no separate attempt. */
	legacy: PublicationRecord | null;
};

/** The chat's records as attempts, newest first. Nothing is merged across attempts or guessed. */
export function attemptsOf(actions: readonly PublicationRecord[]): Attempt[] {
	const out = new Map<string, Attempt>();
	for (const a of actions) {
		const p = a.publication;
		const id = p ? p.attemptId : a.id;
		const at = out.get(id) ?? { id, kind: a.kind, dispatch: null, result: null, legacy: null };
		if (!p) at.legacy = a;
		else if (p.evidence === "command-dispatch") at.dispatch = a;
		else at.result = a;
		out.set(id, at);
	}
	const time = (t: Attempt) => (t.result ?? t.dispatch ?? t.legacy)?.at ?? 0;
	return [...out.values()].sort((a, b) => time(b) - time(a));
}

/** An identifier's first twelve characters, as Pilot shows commits. */
export function shortId(id: string): string {
	return id.slice(0, 12);
}

/** A saved time in UTC, to the minute. */
export function whenOf(ms: number): string {
	return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15
		? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`
		: "Time unknown";
}

/** What an attempt was: "Push main", "Open a pull request". */
export function attemptName(t: Attempt): string {
	const a = t.result ?? t.dispatch ?? t.legacy;
	if (t.kind === "pr_opened") return "Open a pull request";
	return a?.branch ? `Push ${a.branch}` : "Push";
}

/**
 * How an attempt ended, from its own saved records only. A command's success
 * is not proof of what reached GitHub, and a missing result stays Unknown.
 */
export function attemptOutcome(t: Attempt): { word: string; known: boolean } {
	const r = t.result ?? t.legacy;
	if (!r) return { word: "No result saved. Unknown.", known: false };
	const confirmed = r.publication ? r.publication.stage === "confirmed" : r.exitCode === 0;
	if (confirmed && t.kind === "pr_opened")
		return { word: r.prNumber ? `Created PR #${r.prNumber}` : "Command succeeded", known: true };
	if (confirmed) return { word: "Command succeeded", known: true };
	if (r.exitCode !== null && r.exitCode !== 0) return { word: `Failed, exit ${r.exitCode}`, known: true };
	return { word: "Unknown", known: false };
}

/** The local tip a push selected before it ran. It is never proof that this revision reached GitHub. */
export function selectionLine(t: Attempt): string {
	const local = (t.dispatch ?? t.result)?.publication?.local;
	if (!local) return "";
	if (local.status !== "owned") return "Pilot did not save which local revision it selected.";
	const tips = local.revisions.map((r) => `${shortId(r.commitId)} (change ${shortId(r.changeId)})`).join(", ");
	return `Selected locally before it ran: ${tips}. Not proof that it reached GitHub.`;
}

/** The row of `link` on result `key`. */
export function inspectionKey(key: string, link: { sessionId: string; artifactId: string }): string {
	return `${key}|${link.sessionId}/${link.artifactId}`;
}

/** The pin `link` names on `work`, when it is still exactly the one `i` read. */
export function inspectionCurrent(i: Inspection, key: string, work: DeliveredWork): boolean {
	if (i.key !== key) return false;
	const link = work.artifacts.find((a) => a.artifactId === i.pin.artifactId && a.sessionId === i.pin.sourceSessionId);
	const pin = link ? artifactSelection(work, link) : null;
	return !!link && !!pin && link.kind === i.kind && samePin(pin, i.pin);
}

/** Whether `i` is about `link` on `work`. */
export function inspects(i: Inspection | null, key: string, work: DeliveredWork, link: ArtifactLink): boolean {
	return (
		!!i &&
		i.pin.artifactId === link.artifactId &&
		i.pin.sourceSessionId === link.sessionId &&
		i.pin.revision === link.revision &&
		inspectionCurrent(i, key, work)
	);
}

/** What `link`'s row shows now, when it is still exactly the pin read. */
export function inspectionOf(key: string, work: DeliveredWork, link: ArtifactLink): Inspection | null {
	const i = inspections()[inspectionKey(key, link)] ?? null;
	return inspects(i, key, work, link) ? i : null;
}

/** The row on result `key` opened last, for Escape. */
export function lastInspection(key: string): Inspection | null {
	let last: Inspection | null = null;
	for (const i of Object.values(inspections())) {
		if (i.key === key && (!last || i.generation > last.generation)) last = i;
	}
	return last;
}

/**
 * Reads the saved source of `link` on the result shown, for one press or
 * the page's first preview. What its row showed before goes first; only the
 * newest read of that row shows. A press while the same pin is reading does
 * nothing. A preview beyond `MAX_PREVIEWS` closes the page's oldest one.
 */
export async function inspectArtifact(
	source: DeliverySource,
	key: string,
	shown: DeliveredWork,
	link: ArtifactLink,
	mode: "source" | "preview" = "source",
) {
	if (mode === "preview" && link.kind !== "nsh") return;
	const pin = artifactSelection(shown, link);
	if (!pin) return;
	const row = inspectionKey(key, link);
	const now = inspections()[row];
	if (now && now.state === "reading" && samePin(now.pin, pin)) return;
	const generation = ++generations;
	const reading: Inspection = {
		key,
		pin,
		kind: link.kind,
		title: link.title,
		generation,
		state: "reading",
		...(mode === "preview" ? { preview: true } : {}),
		artifact: null,
		message: "",
	};
	glide();
	inspections.update((all) => {
		const next = { ...all, [row]: reading };
		if (mode === "preview") {
			const open = Object.entries(next)
				.filter(([, i]) => i.key === key && i.preview)
				.sort(([, a], [, b]) => a.generation - b.generation);
			for (const [k] of open.slice(0, Math.max(0, open.length - MAX_PREVIEWS))) delete next[k];
		}
		return next;
	});
	const r = await source.inspect(shown, link);
	if (inspections()[row]?.generation !== generation) return;
	inspections.update((all) => ({
		...all,
		[row]:
			r.status === "shown"
				? { ...reading, state: "shown", artifact: r.artifact }
				: { ...reading, state: "refused", message: r.message },
	}));
}

/** Hides one row's source or preview and drops it. An answer still on its way is not shown. */
export function hideArtifact(key: string, link: { sessionId: string; artifactId: string }) {
	const row = inspectionKey(key, link);
	if (!inspections()[row]) return;
	inspections.update((all) => {
		const next = { ...all };
		delete next[row];
		return next;
	});
}

/** Drops the rows of result `key` that `keep` refuses. */
export function dropInspections(key: string, keep: (i: Inspection) => boolean) {
	const gone = Object.entries(inspections()).filter(([, i]) => i.key === key && !keep(i));
	if (gone.length === 0) return;
	inspections.update((all) => {
		const next = { ...all };
		for (const [k] of gone) delete next[k];
		return next;
	});
}

/** Hides every shown source and preview. An answer still on its way is not shown. */
export function hideInspection() {
	if (Object.keys(inspections()).length > 0) inspections.set({});
}

/** An artifact kind in a word or two. */
export function kindName(kind: string): string {
	switch (kind) {
		case "html":
			return "HTML";
		case "react":
			return "React";
		case "swiftui":
			return "SwiftUI";
		case "image":
			return "Image";
		case "shader":
			return "Shader";
		case "visual":
			return "Visual";
		case "nsh":
			return "NSH";
		default:
			return "Artifact";
	}
}

/** An artifact output's kind and pinned revision: "HTML, revision 3". */
export function artifactLine(link: ArtifactLink): string {
	return link.revision
		? `${kindName(link.kind)}, revision ${link.revision}`
		: `${kindName(link.kind)}, latest revision`;
}

/** Why a saved source is not shown, in one sentence. Never a part of it instead. */
export function unavailableLine(kind: string, reason: string): string {
	switch (reason) {
		case "missing":
			return "Pilot has no saved copy of this revision.";
		case "oversize":
			return "This revision's saved copy is too large to show here. Pilot does not show part of it instead.";
		case "redacted":
			return "Pilot held this source back because it may contain a secret.";
		case "invalid":
			return "This revision's saved copy is damaged, so Pilot does not show it.";
		default:
			if (kind === "image") return "Pilot shows only an image's title and kind here. It does not draw images.";
			if (kind === "nsh") return "Pilot does not run NSH artifacts yet, and cannot show this source here.";
			return "Pilot cannot show this kind of source here.";
	}
}

/** The most lines and characters a source shows before the user asks for all of it. */
export const SOURCE_LINES = 400;
export const SOURCE_CHARS = 40_000;

function count(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The start of a long source, and a note that says how much shows. All of it when `all`. */
export function excerpt(source: string, all: boolean): { text: string; note: string } {
	if (all) return { text: source, note: "" };
	const lines = source.split("\n");
	let text = lines.length > SOURCE_LINES ? lines.slice(0, SOURCE_LINES).join("\n") : source;
	if (text.length > SOURCE_CHARS) {
		let end = SOURCE_CHARS;
		const c = text.charCodeAt(end - 1);
		if (c >= 0xd800 && c <= 0xdbff) end--;
		text = text.slice(0, end);
		return { text, note: `Showing the first ${count(end)} of ${count(source.length)} characters.` };
	}
	if (lines.length > SOURCE_LINES) {
		return { text, note: `Showing the first ${count(SOURCE_LINES)} of ${count(lines.length)} lines.` };
	}
	return { text: source, note: "" };
}

/** A saved copy's size: "820 bytes", "12.4 KB". */
export function sizeOf(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The most results whose ticked reminders a saved window keeps: those ticked last. */
export const SAVED_REMINDERS = 20;

const TICK = /^(report|pr-[A-Za-z0-9_-]{1,128}|art-[A-Za-z0-9_-]{1,128})$/;
const DELIVERY = /^[0-9a-f]{64}$/i;

/** The key of one delivery's reminders. A newer delivery of the same result starts with none ticked. */
export function reminderKey(resultKey: string, deliveryId: string): string {
	return `${resultKey}#${deliveryId}`;
}

/** Sets one delivery's ticked reminders. It moves to the end, so a saved window keeps it first; none forgets it. */
export function setTicks(key: string, ticks: string[]) {
	reminders.update((all) => {
		const next = { ...all };
		delete next[key];
		if (ticks.length > 0) next[key] = ticks;
		return next;
	});
}

/** Ticked reminders as a saved window keeps them: "<result key>#<delivery>\n<tick>\n<tick>". */
export function savedReminders(): string[] {
	return Object.entries(reminders())
		.filter(([, ticks]) => ticks.length > 0)
		.slice(-SAVED_REMINDERS)
		.map(([key, ticks]) => [key, ...ticks].join("\n"));
}

/** Ticked reminders from a saved window. Entries that do not name an exact result and delivery are dropped. */
export function remindersOf(saved: readonly string[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const entry of saved) {
		const [key, ...ticks] = entry.split("\n");
		const at = key.lastIndexOf("#");
		if (at <= 0 || !subjectOf(key.slice(0, at)) || !DELIVERY.test(key.slice(at + 1))) continue;
		const kept = [...new Set(ticks.filter((t) => TICK.test(t)))];
		if (kept.length > 0) out[key] = kept;
	}
	return out;
}

/** Opens the page of `subject`, named `title` when Pilot knows it. */
export function openDelivery(subject: VerificationSubject, title: string, work = false) {
	const key = deliveryKey(subject);
	if (title) deliveryTitles.update((all) => ({ ...all, [key]: title }));
	doneAsk.set(null);
	hideInspection();
	agentWork.set({});
	workOnOpen.set(work ? key : null);
	glide();
	deliveryRoute.set({ key, subject, title: title || deliveryTitles()[key] || "" });
}

/** Back to the screen under the page. Unsent notes stay. */
export function closeDelivery() {
	doneAsk.set(null);
	hideInspection();
	agentWork.set({});
	workOnOpen.set(null);
	deliveryRoute.set(null);
}

/** The words Pilot uses for a result it has no title for. */
export function titleOf(key: string, subject: VerificationSubject, missionTitle?: string): string {
	const known = deliveryTitles()[key];
	if (known) return known;
	if (subject.kind === "chat") return "A standalone chat's result";
	return missionTitle ? `A task in ${missionTitle}` : "A mission task's result";
}

/** Sets or removes one result's unsent note. An empty note is forgotten. */
export function setNote(key: string, note: string) {
	backNotes.update((all) => {
		const next = { ...all };
		if (note === "") delete next[key];
		else next[key] = note;
		return next;
	});
}

/** The pull requests that belong to the result: its own, else every one it names. */
export function ownPullRequests(work: DeliveredWork): DeliveredWork["pullRequests"] {
	const own = work.pullRequests.filter((r) => r.relationship === "ownership");
	return own.length > 0 ? own : work.pullRequests;
}

/** Whether a pull request of the result is not merged yet, or its state is not known. */
export function pullRequestOpen(work: DeliveredWork): boolean {
	return ownPullRequests(work).some((r) => r.pullRequest?.state !== "merged");
}

type PR = DeliveredWork["pullRequests"][number];

/** A pull request's name: "PR #12 · Title". */
export function prName(r: PR): string {
	const p = r.pullRequest;
	const name = p?.number ? `PR #${p.number}` : "Pull request";
	const title = p?.title || r.title || "";
	return title ? `${name} · ${title}` : name;
}

/** A pull request's last state Pilot saw, in a few words. Merged is never released. */
export function prState(r: PR): string {
	switch (r.pullRequest?.state) {
		case "merged":
			return "Merged";
		case "open":
			return "Open, not merged";
		case "draft":
			return "Draft, not merged";
		case "closed":
			return "Closed without merging";
		default:
			return "State not seen yet";
	}
}

/** Saved observations, never a promise that the PR or checks are current. */
export function prObservation(r: PR): string {
	const at = (n: number | undefined) =>
		n && Number.isFinite(n) && n > 0 && n <= 8.64e15 ? new Date(n).toISOString() : "unknown";
	const pr = r.pullRequest;
	const health = pr?.readiness;
	const failed = health?.reasons.find((reason) => reason.code === "failing_checks");
	const checks = !health?.checkedAt
		? "Checks not observed."
		: failed
			? `Checks failed${failed.names?.length ? `: ${failed.names.join(", ")}` : ""}.`
			: `Readiness ${health.state}.`;
	return `PR state last observed: ${at(pr?.checkedAt)}. ${checks}${health?.checkedAt ? ` Health last observed: ${at(health.checkedAt)}.` : ""} Saved observations may have changed.`;
}

/** What the agent says about its work: the first of the four lines. */
export function agentLine(work: DeliveredWork): string {
	const v = work.verificationCurrent ? work.verification : null;
	if (v?.state === "sent_back") return "Has your note. No new result yet.";
	if (!work.deliveryId) return "Has not delivered a result yet.";
	if (work.completion) return `Says it finished. Commit ${work.completion.commit.slice(0, 7)}.`;
	if (work.nonCodeDelivery) return "Says it finished, without code changes.";
	if (work.submission) return "Submitted its result.";
	if (work.outcome) return work.outcome.reason ? `Says it is done: ${work.outcome.reason}` : "Says it is done.";
	return "Delivered a result.";
}

/** The pull requests in one line: the second of the four lines. */
export function pullRequestLine(work: DeliveredWork): string {
	const prs = ownPullRequests(work);
	if (prs.length === 0) return "None linked.";
	const first = `${prName(prs[0]).split(" · ")[0]}: ${prState(prs[0]).toLowerCase()}.`;
	return prs.length === 1 ? first : `${first} ${prs.length - 1} more below.`;
}

/** Production, the third line. Pilot does not track releases, so it never says released. */
export function productionLine(work: DeliveredWork): string {
	return ownPullRequests(work).some((r) => r.pullRequest?.state === "merged")
		? "Not tracked. Merged is not released."
		: "Not tracked.";
}

/** The user's own check, the fourth line. Only a matching receipt says Done. */
export function checkLine(work: DeliveredWork, unsettled: DeliveryOp | undefined): string {
	if (unsettled) return "Not confirmed. Check only.";
	if (work.pendingOperationId) return "Waiting for Pilot to confirm an earlier check.";
	const v = work.verification;
	if (work.verificationCurrent && v) {
		if (v.state === "done") return "Done. You accepted this result.";
		if (v.state === "sent_back") return "Sent back with your note.";
		return "Open again. Not checked yet.";
	}
	if (!work.deliveryId) return "Nothing to check yet.";
	if (v && v.deliveryId !== work.deliveryId) return "Not checked. Your earlier check was for an earlier result.";
	return "Not checked yet.";
}

/** Whether the result waits for the user's check now. */
export function waitsForCheck(work: DeliveredWork | null, unsettled: DeliveryOp | undefined): boolean {
	if (!work?.deliveryId || unsettled || work.pendingOperationId) return false;
	return !work.verificationCurrent || work.verification?.state === "open";
}

/** What a settled command did, in one sentence. Not the user's whole check. */
export function settledLine(op: DeliveryOp, title: string): string {
	const name = `“${title}”`;
	if (op.state === "accepted") {
		if (op.action === "done") return `Marked ${name} done. Nothing was merged, released or replied to.`;
		if (op.action === "send_back") return `Sent ${name} back. The agent has your note.`;
		return `Opened ${name} again for your check.`;
	}
	if (op.state === "not-sent") return `Pilot did not send your check of ${name}. Nothing changed.`;
	return `Pilot did not change ${name}.`;
}

/** An unsettled command, in one sentence. */
export function unsettledLine(op: DeliveryOp, title: string): string {
	const what = op.action === "done" ? "Marking" : op.action === "send_back" ? "Sending back" : "Reopening";
	const done = op.action === "done" ? " done" : "";
	return `${what} “${title}”${done} is not confirmed.`;
}
