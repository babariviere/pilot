// When a planning page is older than a later inventory row of its mission.
// Pure, with no transport, so the screens' tests can check every case.
import type { PlanPage, PlanRow } from "pilot-day/native";

/**
 * Whether `page` is older than `row`, read later from a complete inventory.
 * Older: the row names a newer revision of the same interview, a newer round
 * of the same enrollment, another enrollment, or an interview where the page
 * shows none. A row that only lags behind the page, a mission no longer
 * listed and a page that cannot be shown do not make it older; the root
 * checks every save and submission again.
 */
export function olderThanList(page: PlanPage, row: PlanRow | undefined): boolean {
	const identity = row?.identity;
	if (!page.available || !row || !identity) return false;
	// Plan changes can leave the interview untouched. Both values already
	// come from canonical plan reads, not a second currentness contract.
	const revision = page.map?.revision ?? page.work?.revision;
	if (typeof identity.planRevision === "number" && revision !== undefined && identity.planRevision > revision)
		return true;
	const iv = page.interview;
	if (!iv) return row.needsYou;
	if (iv.id === identity.interviewId) return identity.interviewRevision > iv.revision;
	// Both name one enrollment's question list as "<enrollment>-<round>".
	const cut = identity.interviewId.lastIndexOf("-");
	const round = Number(identity.interviewId.slice(cut + 1));
	const sameEnrollment = cut > 0 && iv.id === `${identity.interviewId.slice(0, cut)}-${iv.questionSet}`;
	return !(sameEnrollment && Number.isSafeInteger(round) && round < iv.questionSet);
}
