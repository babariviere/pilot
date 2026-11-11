// What the start and end of day and the standup notes say, from Today's
// read model and the recap's results. Nothing here guesses: results keep
// what they rest on (an agent's report, a landing or the user's
// acceptance), results that could not be read are never "none", plans are
// the agents' own next steps, and a read that is not live says so.
import type { DoneBasis, DoneEntry, MissionRow, Today } from "pilot-day/native";
import type { Recap } from "./ritualFeed";
import { type Item, queue } from "./view";
import { provenance, rowLine, stateWord } from "./words";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** "One thing", "Three things", "12 things". */
export function things(n: number): string {
	return `${WORDS[n] ?? String(n)} ${n === 1 ? "thing" : "things"}`;
}

/** What a result rests on, in a few words. */
export function basisWord(basis: DoneBasis): string {
	switch (basis) {
		case "reported":
			return "Agent report";
		case "landed":
			return "Landed";
		case "accepted":
			return "Accepted";
	}
}

/** The first words of a start of day. */
export function greeting(today: Today): string {
	if (today.visit === "first") return "Welcome to Pilot.";
	return today.part === "morning" ? "Good morning." : "Welcome back.";
}

/** What the start of day catches up on. */
export function sinceLine(today: Today): string {
	if (today.visit === "first") return "This is your first look, so there is nothing to catch up on yet.";
	if (today.lastLooked) return `Here is what happened since you looked ${today.lastLooked}.`;
	return "Here is what Pilot has read.";
}

/** The results a ritual lists, newest first. None when they could not be read. */
export function recapResults(recap: Recap): DoneEntry[] {
	return recap.state === "live" ? recap.entries : [];
}

/** How many results a ritual does not list. */
export function moreResults(recap: Recap): number {
	return recap.state === "live" ? recap.more : 0;
}

/** Where a result belongs and what it rests on: "Faster search · Landed", or the basis alone. */
export function resultSource(entry: DoneEntry): string {
	return entry.missionTitle ? `${entry.missionTitle} · ${basisWord(entry.basis)}` : basisWord(entry.basis);
}

/** How many results came in since the user looked, in a sentence. */
export function resultsLine(today: Today, recap: Recap): string {
	if (recap.state === "off") return "Pilot could not read results.";
	const n = recap.entries.length + recap.more;
	const count = n === 0 ? "No results" : n === 1 ? "One result" : `${WORDS[n] ?? String(n)} results`;
	return today.lastLooked ? `${count} since you looked ${today.lastLooked}.` : `${count} so far.`;
}

/** What waits for the user, in a sentence. */
export function waitingLine(today: Today): string {
	const n = queue(today).length;
	if (n === 0) return "Nothing waits for you.";
	return `${things(n)} still ${n === 1 ? "waits" : "wait"} for you.`;
}

/** The title of an item that waits, as a list shows it. */
export function itemTitle(item: Item): string {
	return item.kind === "decision" ? item.decision.title : `Action for you: ${item.action.title}`;
}

/** How long an item takes, as its agent wrote it. */
export function itemEffort(item: Item): string {
	return item.kind === "decision" ? item.decision.effort : item.action.effort;
}

/** A mission's next step: its agent's own words, else its line. */
export function nextLine(row: MissionRow): string {
	if (row.report?.nextStep) return `Next: ${row.report.nextStep}`;
	return rowLine(row) || row.report?.summary || "";
}

/** Where a mission's line comes from: its report's provenance, else its state. */
export function sourceLine(row: MissionRow): string {
	return row.report ? provenance(row.report) : stateWord(row);
}

/** Every mission Today shows: moving, not moving, then with no current report. */
export function missionRows(today: Today): MissionRow[] {
	return [...today.moving, ...today.notMoving, ...today.unreported];
}

/** One part of the standup notes. */
export type StandupPart = { title: string; lines: string[] };

/** The provenance of a report, in brackets for the notes. */
function said(row: MissionRow): string {
	if (!row.report) return "no report yet";
	switch (row.report.currentness) {
		case "current":
			return `agent report, ${row.report.age}`;
		case "stale":
			return `old agent report, ${row.report.age}`;
		case "unavailable":
			return "report could not be checked";
	}
}

/**
 * The standup notes, in the user's own voice: what is done, what comes
 * next and what waits. Each line keeps what it rests on.
 */
export function standup(today: Today, recap: Recap): StandupPart[] {
	const done = recapResults(recap).map((d) =>
		d.missionTitle
			? `${d.text} (${basisWord(d.basis).toLowerCase()}, ${d.missionTitle})`
			: `${d.text} (${basisWord(d.basis).toLowerCase()})`,
	);
	const more = moreResults(recap);
	if (more > 0) done.push(`And ${more} more ${more === 1 ? "result" : "results"}.`);
	if (recap.state === "off") done.push("Results could not be read here, which is not the same as none.");
	else if (recap.limited) done.push("Only the newest kept changes were read.");
	const next = today.moving.map((row) => `${row.title}: ${row.report?.nextStep || nextLine(row)} (${said(row)})`);
	const waiting = [
		...queue(today).map((item) =>
			item.kind === "decision"
				? `${item.decision.missionTitle}: ${item.decision.title} (needs my decision)`
				: `${item.action.title} (needs me)`,
		),
		...today.notMoving.map((row) => `${row.title}: ${stateWord(row).toLowerCase()} (${said(row)})`),
		...today.unreported.map((row) => `${row.title}: ${stateWord(row).toLowerCase()}`),
	];
	return [
		{ title: "Done", lines: done },
		{ title: "Next", lines: next },
		{ title: "Waiting", lines: waiting },
	];
}
