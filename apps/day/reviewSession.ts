// One result version's private review, as a page reads and writes it: the saved comments and note, the saved
// comparison shown, the unsent draft and its saves. The result page and Review code each hold one while they show.
// Every write goes through `ResultReviewSource` (resultReview.ts); nothing here posts to GitHub or sends to an agent.
import { cleanup, computed, effect, signal, untracked } from "nsh";
import type { DeliveredWork } from "./deliveryContract";
import {
	forgetReviewDraft,
	keepReviewDraft,
	type ResultAnchor,
	type ResultDiff,
	type ResultReviewEntry,
	type ResultReviewPage,
	type ResultReviewSource,
	type ReviewDraft,
	reviewDrafts,
	reviewKey,
	sameReviewAnchor,
} from "./resultReview";

export type LineAnchor = Extract<ResultAnchor, { kind: "lines" }>;
export type ReviewFile = ResultDiff["files"][number];
export type LineCounts = { added: number; deleted: number };

/**
 * The most line comparisons one file's counts make. It keeps the page's thread free while counts compute:
 * 100,000 took about 20 ms in QuickJS on a rewritten 2,000-line file. Past it the counts compare the changed
 * lines as sets, so a moved line counts as unchanged.
 */
const MAX_STEPS = 100_000;

/** Lines added and deleted between two saved texts, as their diff shows them. */
export function lineCounts(before: string, after: string): LineCounts {
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const n = endA - start;
	const m = endB - start;
	if (n === 0 || m === 0) return { added: m, deleted: n };
	const max = n + m;
	const v = new Int32Array(2 * max + 3);
	const at = max + 1;
	let steps = 0;
	for (let d = 0; d <= max && steps < MAX_STEPS; d++) {
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[at + k - 1] < v[at + k + 1]) ? v[at + k + 1] : v[at + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[start + x] === b[start + y]) {
				x++;
				y++;
			}
			steps += x - v[at + k] + 1;
			v[at + k] = x;
			if (x >= n && y >= m) return { added: (d - n + m) / 2, deleted: (d + n - m) / 2 };
		}
	}
	const left = new Map<string, number>();
	for (let i = start; i < endA; i++) left.set(a[i], (left.get(a[i]) ?? 0) + 1);
	let kept = 0;
	for (let i = start; i < endB; i++) {
		const count = left.get(b[i]) ?? 0;
		if (count > 0) {
			left.set(b[i], count - 1);
			kept++;
		}
	}
	return { added: m - kept, deleted: n - kept };
}

/** The file a line anchor names in this comparison, by its side's path and exact saved bytes. */
export function anchorFile(diff: ResultDiff, anchor: LineAnchor): ReviewFile | undefined {
	if (anchor.snapshotId !== diff.snapshotId) return undefined;
	return diff.files.find((f) => f[anchor.side]?.path === anchor.path && f[anchor.side]?.sha256 === anchor.blobSha256);
}

/**
 * Reads and writes the private review of `work()`'s version. Reads start while `fresh()` and stop when it is
 * not; `onLater` runs once a Later save is confirmed.
 */
export function reviewSession(
	work: () => DeliveredWork,
	fresh: () => boolean,
	source: ResultReviewSource,
	onLater?: () => void,
) {
	const page = signal<ResultReviewPage | null>(null);
	const diff = signal<ResultDiff | null>(null);
	const message = signal("");
	const pending = signal<string[]>([]);
	const busy = signal(false);
	const readable = signal(false);
	const failed = signal(false);
	const historyBefore = signal<number | undefined>(undefined);
	const deliveryId = untracked(work).deliveryId ?? "";
	const key = reviewKey(untracked(work));
	let alive = true;
	let readVersion = 0;
	let diffVersion = 0;
	cleanup(() => {
		alive = false;
	});
	const draft = (): ReviewDraft => reviewDrafts()[key] ?? { kind: "comment", body: "", anchor: { kind: "general" } };
	/** The result page's editor: a general comment (Add a note) or the private note (My notes) is open. */
	const editorOpen = signal(untracked(() => draft().anchor.kind === "general" && draft().body !== ""));
	const comments = (): ResultReviewEntry[] => page()?.entries.filter((e) => e.kind === "comment") ?? [];
	/** This version's saved comments: what Send back includes. */
	const current = () => comments().filter((e) => e.deliveryId === deliveryId);
	/** This version's general comments, the notes Add a note saves. */
	const general = () => current().filter((e) => e.anchor.kind === "general");
	const note = () =>
		page()?.personalNote ??
		page()
			?.entries.filter((e) => e.kind === "note")
			.at(-1)?.body ??
		"";
	const disabled = () => !readable() || !fresh() || busy() || pending().length > 0;
	const counts = computed(() =>
		(diff()?.files ?? []).map((f) => (f.reason ? null : lineCounts(f.before?.text ?? "", f.after?.text ?? ""))),
	);
	const totals = () =>
		counts().reduce<LineCounts>(
			(sum, c) => (c ? { added: sum.added + c.added, deleted: sum.deleted + c.deleted } : sum),
			{ added: 0, deleted: 0 },
		);

	const read = async (before?: number) => {
		const version = ++readVersion;
		try {
			const result = await source.read(work(), before);
			if (!alive || version !== readVersion) return;
			if (result.data.deliveryId !== deliveryId) throw Error("stale");
			page.set(result.data);
			historyBefore.set(before);
			pending.set(result.pending);
			readable.set(true);
			failed.set(false);
		} catch {
			if (alive && version === readVersion) {
				readable.set(false);
				failed.set(true);
				diff.set(null);
				message.set("Private review could not be read. Saved comments stay; refresh before editing.");
			}
		}
	};
	const openDiff = async (snapshotId: string) => {
		if (!fresh()) return;
		const version = ++diffVersion;
		diff.set(null);
		try {
			const result = await source.diff(work(), snapshotId);
			if (alive && version === diffVersion) {
				diff.set(result);
				message.set("");
			}
		} catch {
			if (alive && version === diffVersion)
				message.set("This saved comparison is unavailable. Pilot did not substitute live files.");
		}
	};
	/**
	 * Opens the result page's editor: a general comment, which Send back includes, or the private note, which it
	 * never does. Unsent words of another kind or place keep their place.
	 */
	const startEditor = (kind: "comment" | "note") => {
		if (disabled()) return;
		const d = draft();
		if (d.body && (d.kind !== kind || d.anchor.kind !== "general")) {
			message.set(
				d.anchor.kind === "lines"
					? "Save or discard your unsent code comment on Review code first."
					: "Save or discard the words already open below first.",
			);
			editorOpen.set(d.anchor.kind === "general");
			return;
		}
		if (!d.body) keepReviewDraft(key, { kind, anchor: { kind: "general" }, body: kind === "note" ? note() : "" });
		editorOpen.set(true);
		message.set("");
	};
	const save = async (kind: "comment" | "note" | "later" | "select" = draft().kind): Promise<boolean> => {
		const shown = page();
		if (disabled() || !shown) return false;
		busy.set(true);
		message.set("");
		const submitted = JSON.stringify(draft());
		const edit = {
			deliveryId,
			expectedRevision: shown.revision,
			kind,
			body: kind === "comment" || kind === "note" ? draft().body : "",
			anchor: kind === "comment" ? draft().anchor : { kind: "general" as const },
		};
		try {
			const result = await source.save(work(), edit);
			if (!alive) return false;
			const id = result.operationId;
			if (result.state === "rejected") {
				await read();
				message.set(
					"Not saved. The review changed or this save was refused. Your words stay; refresh before trying again.",
				);
				return false;
			}
			if (
				result.state !== "saved" ||
				result.receipt?.operationId !== id ||
				result.receipt.body !== edit.body ||
				result.receipt.deliveryId !== edit.deliveryId ||
				result.receipt.kind !== edit.kind
			) {
				pending.set([id]);
				message.set("Save not confirmed. Check only reads its receipt; nothing will be resent.");
				return false;
			}
			if ((kind === "comment" || kind === "note") && JSON.stringify(draft()) === submitted) {
				if (edit.anchor.kind === "general") editorOpen.set(false);
				forgetReviewDraft(key);
			}
			await read();
			if (kind === "later" && alive) onLater?.();
			else if (kind === "select") message.set("This older result was explicitly added to your review queue.");
			return true;
		} catch (error) {
			if (!alive) return false;
			const id = (error as { operationId?: string }).operationId;
			if (id) {
				pending.set([id]);
				message.set("Save not confirmed. Your words stay. Check reads only; no resend.");
			} else message.set("The save could not be prepared. Nothing was sent; your words stay.");
			return false;
		} finally {
			if (alive) busy.set(false);
		}
	};
	const check = async (id: string) => {
		if (busy()) return;
		busy.set(true);
		try {
			const result = await source.check(id);
			if (!alive) return;
			if (result.state === "saved" && result.receipt?.operationId === id) {
				if (
					result.receipt.deliveryId === deliveryId &&
					result.receipt.body === draft().body &&
					result.receipt.kind === draft().kind &&
					sameReviewAnchor(result.receipt.anchor, draft().anchor)
				) {
					forgetReviewDraft(key);
					editorOpen.set(false);
				}
				message.set("Saved. Nothing was resent.");
				await read();
				if (result.receipt.kind === "later" && result.receipt.deliveryId === deliveryId && alive) onLater?.();
			} else if (result.state === "rejected" && result.receipt?.operationId === id) {
				await read();
				message.set("Not saved. Your words stay; nothing was resent.");
			} else message.set("Still unconfirmed. Nothing was resent.");
		} catch {
			if (alive) message.set("Receipt unavailable. Nothing was resent.");
		} finally {
			if (alive) busy.set(false);
		}
	};
	effect(() => {
		const now = fresh();
		untracked(() => {
			if (!now) {
				readVersion++;
				diffVersion++;
				readable.set(false);
				diff.set(null);
				return;
			}
			void read().then(() => {
				const first = page()?.snapshots[0];
				if (alive && first && !diff()) void openDiff(first);
			});
		});
	});
	return {
		key,
		deliveryId,
		page,
		diff,
		message,
		pending,
		busy,
		readable,
		failed,
		historyBefore,
		editorOpen,
		draft,
		comments,
		current,
		general,
		note,
		disabled,
		counts,
		totals,
		read,
		openDiff,
		startEditor,
		save,
		check,
		/** The result has saved code to review, or its review could not be read. */
		hasCode: () => failed() || (page()?.snapshots.length ?? 0) > 0,
	};
}

export type ReviewSession = ReturnType<typeof reviewSession>;
