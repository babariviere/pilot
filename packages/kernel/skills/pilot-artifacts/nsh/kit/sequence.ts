// Layout for SequenceDiagram: participants in columns, steps in rows from
// top to bottom. Pure and deterministic, like the flow layout.
import { attempt, flag, type Laid, list, Problem, record, text } from "./check";
import type { Point } from "./flow";
import { wrap } from "./text";

export interface SequenceParticipant {
	id: string;
	label: string;
}

/** One message from a participant to another, or to itself. A reply is drawn dashed. */
export interface SequenceMessage {
	from: string;
	to: string;
	label: string;
	reply?: boolean;
}

/** A note over one participant, or spanning two. */
export interface SequenceNote {
	note: string;
	over: string | readonly [string, string];
}

export type SequenceStep = SequenceMessage | SequenceNote;

export interface SequenceSpec {
	participants: readonly SequenceParticipant[];
	steps: readonly SequenceStep[];
}

/** The most a sequence may hold. Larger data is refused, never cut. */
export const SEQUENCE_LIMITS = { participants: 10, steps: 80, id: 40, label: 60, message: 100, note: 160 } as const;

export interface PlacedParticipant {
	id: string;
	label: string;
	/** The lifeline's x. */
	x: number;
	box: { x: number; y: number; width: number; height: number };
	lines: number;
}

export interface PlacedMessage {
	kind: "message";
	from: string;
	to: string;
	label: string;
	dashed: boolean;
	self: boolean;
	/** Straight segments from the sender's lifeline to the receiver's. */
	path: Point[];
	tip: Point;
	angle: number;
	text: { x: number; y: number; width: number; lines: number; clipped: boolean };
}

export interface PlacedNote {
	kind: "note";
	note: string;
	box: { x: number; y: number; width: number; height: number };
	lines: number;
	clipped: boolean;
}

export interface SequenceLayout {
	width: number;
	height: number;
	participants: PlacedParticipant[];
	steps: (PlacedMessage | PlacedNote)[];
	lifeline: { top: number; bottom: number };
	summary: string;
}

/** Sizes in points at text scale 1. Text sizes match `text-sm` and `text-xs`. */
export const SEQUENCE_METRICS = {
	column: 168,
	headPadX: 10,
	headPadY: 8,
	head: 14,
	headLine: 20,
	headLines: 2,
	text: 12,
	textLine: 16,
	textLines: 3,
	rowGap: 14,
	textGap: 4,
	self: 32,
	selfHeight: 18,
	notePad: 8,
	margin: 16,
} as const;

type Read = { participants: SequenceParticipant[]; steps: SequenceStep[] };

function read(spec: unknown): Read {
	const data = record(spec, "The sequence");
	const ids = new Set<string>();
	const participants = list(data.participants, "participants", 1, SEQUENCE_LIMITS.participants).map((value, i) => {
		const item = record(value, `participants[${i}]`);
		const id = text(item.id, `participants[${i}].id`, SEQUENCE_LIMITS.id);
		if (ids.has(id)) throw new Problem(`Two participants use the id "${id}".`);
		ids.add(id);
		return { id, label: text(item.label, `Participant "${id}" label`, SEQUENCE_LIMITS.label) };
	});
	const known = (id: string, what: string) => {
		if (!ids.has(id)) throw new Problem(`${what} names "${id}", which is not a participant.`);
		return id;
	};
	const steps = list(data.steps, "steps", 1, SEQUENCE_LIMITS.steps).map((value, i): SequenceStep => {
		const step = record(value, `steps[${i}]`);
		if (step.note !== undefined) {
			const note = text(step.note, `steps[${i}].note`, SEQUENCE_LIMITS.note);
			if (typeof step.over === "string") return { note, over: known(step.over, `steps[${i}].over`) };
			const over = list(step.over, `steps[${i}].over`, 2, 2).map((id) =>
				known(text(id, `steps[${i}].over`, SEQUENCE_LIMITS.id), `steps[${i}].over`),
			);
			if (over[0] === over[1]) throw new Problem(`steps[${i}].over names "${over[0]}" twice.`);
			return { note, over: [over[0], over[1]] };
		}
		return {
			from: known(text(step.from, `steps[${i}].from`, SEQUENCE_LIMITS.id), `steps[${i}].from`),
			to: known(text(step.to, `steps[${i}].to`, SEQUENCE_LIMITS.id), `steps[${i}].to`),
			label: text(step.label, `steps[${i}].label`, SEQUENCE_LIMITS.message),
			reply: flag(step.reply, `steps[${i}].reply`),
		};
	});
	return { participants, steps };
}

/** Lays out `spec` at text scale `scale`, or says why it cannot. */
export function layoutSequence(spec: SequenceSpec, scale = 1): Laid<SequenceLayout> {
	return attempt(() => place(read(spec), scale));
}

function place({ participants, steps }: Read, scale: number): SequenceLayout {
	const m = SEQUENCE_METRICS;
	const column = Math.round(m.column * scale);
	const width = 2 * m.margin + participants.length * column;
	const column_x = new Map(participants.map((p, i) => [p.id, m.margin + i * column + column / 2]));
	const label = (id: string) => participants.find((p) => p.id === id)!.label;

	const headWidth = column - 16;
	const headLines = participants.map(
		(p) => wrap(p.label, headWidth - 2 * m.headPadX, m.head * scale, m.headLines).lines,
	);
	const headHeight = Math.ceil(2 * m.headPadY + Math.max(...headLines) * m.headLine * scale);
	const placedParticipants = participants.map((p, i): PlacedParticipant => {
		const x = column_x.get(p.id)!;
		return {
			id: p.id,
			label: p.label,
			x,
			box: { x: x - headWidth / 2, y: m.margin, width: headWidth, height: headHeight },
			lines: headLines[i],
		};
	});

	const lineHeight = m.textLine * scale;
	let y = m.margin + headHeight + m.rowGap;
	const placedSteps = steps.map((step): PlacedMessage | PlacedNote => {
		if ("note" in step) {
			const over = typeof step.over === "string" ? [step.over, step.over] : step.over;
			const xs = over.map((id) => column_x.get(id)!);
			const left = Math.min(...xs) - headWidth / 2;
			const boxWidth = Math.max(...xs) - Math.min(...xs) + headWidth;
			const fit = wrap(step.note, boxWidth - 2 * m.notePad, m.text * scale, m.textLines);
			const height = Math.ceil(2 * m.notePad + fit.lines * lineHeight);
			const box = { x: left, y, width: boxWidth, height };
			y += height + m.rowGap;
			return { kind: "note", note: step.note, box, lines: fit.lines, clipped: fit.clipped };
		}
		const x1 = column_x.get(step.from)!;
		const x2 = column_x.get(step.to)!;
		const self = step.from === step.to;
		const textWidthAvailable = self ? column - 16 : Math.max(Math.abs(x2 - x1) - 16, column - 16);
		const fit = wrap(step.label, textWidthAvailable, m.text * scale, m.textLines);
		const textHeight = fit.lines * lineHeight;
		const textX = self
			? x1 + 6
			: Math.min(Math.max((x1 + x2) / 2 - textWidthAvailable / 2, m.margin), width - m.margin - textWidthAvailable);
		const placedText = { x: textX, y, width: textWidthAvailable, lines: fit.lines, clipped: fit.clipped };
		const arrowY = y + textHeight + m.textGap;
		if (self) {
			const bottom = arrowY + m.selfHeight;
			y = bottom + m.rowGap;
			return {
				kind: "message",
				from: step.from,
				to: step.to,
				label: step.label,
				dashed: step.reply ?? false,
				self,
				path: [
					{ x: x1, y: arrowY },
					{ x: x1 + m.self, y: arrowY },
					{ x: x1 + m.self, y: bottom },
					{ x: x1, y: bottom },
				],
				tip: { x: x1, y: bottom },
				angle: Math.PI,
				text: placedText,
			};
		}
		y = arrowY + m.rowGap;
		return {
			kind: "message",
			from: step.from,
			to: step.to,
			label: step.label,
			dashed: step.reply ?? false,
			self,
			path: [
				{ x: x1, y: arrowY },
				{ x: x2, y: arrowY },
			],
			tip: { x: x2, y: arrowY },
			angle: x2 > x1 ? 0 : Math.PI,
			text: placedText,
		};
	});
	const bottom = y;
	const words = steps.map((step) =>
		"note" in step
			? `Note: ${step.note}`
			: `${label(step.from)} to ${step.from === step.to ? "itself" : label(step.to)}${step.reply ? " (reply)" : ""}: ${step.label}`,
	);
	return {
		width: Math.ceil(width),
		height: Math.ceil(bottom + m.margin),
		participants: placedParticipants,
		steps: placedSteps,
		lifeline: { top: m.margin + headHeight, bottom },
		summary: `Sequence between ${participants.map((p) => p.label).join(", ")}. ${words.join(". ")}.`,
	};
}
