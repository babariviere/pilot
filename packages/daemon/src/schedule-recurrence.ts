import type { ScheduleRecurrence } from "@pilot/protocol";

export function validateRecurrence(value: unknown): ScheduleRecurrence {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recurrence is required");
	const r = value as ScheduleRecurrence;
	if (!["day", "week", "month"].includes(r.every)) throw new Error("Invalid recurrence period");
	if (typeof r.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new Error("time must be HH:MM");
	if (typeof r.timeZone !== "string" || r.timeZone.length > 100) throw new Error("Invalid time zone");
	try {
		new Intl.DateTimeFormat("en", { timeZone: r.timeZone });
	} catch {
		throw new Error("Invalid time zone");
	}
	const day = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max;
	if (r.every === "day") {
		if (r.weekday !== undefined || r.dayOfMonth !== undefined) throw new Error("Invalid daily fields");
		if (
			r.weekdays !== undefined &&
			(!Array.isArray(r.weekdays) ||
				!r.weekdays.length ||
				r.weekdays.length > 7 ||
				!r.weekdays.every((n) => day(n, 7)) ||
				new Set(r.weekdays).size !== r.weekdays.length)
		)
			throw new Error("Invalid weekdays");
	} else if (r.every === "week") {
		if (!day(r.weekday, 7) || r.weekdays !== undefined || r.dayOfMonth !== undefined)
			throw new Error("Invalid weekly fields");
	} else if (!day(r.dayOfMonth, 31) || r.weekdays !== undefined || r.weekday !== undefined)
		throw new Error("Invalid monthly fields");
	return {
		every: r.every,
		time: r.time,
		timeZone: r.timeZone,
		...(r.weekdays ? { weekdays: [...r.weekdays].sort((a, b) => a - b) } : {}),
		...(r.weekday ? { weekday: r.weekday } : {}),
		...(r.dayOfMonth ? { dayOfMonth: r.dayOfMonth } : {}),
	};
}

const DAY = 86_400_000;
export class RecurrenceCalendar {
	private readonly formatter: Intl.DateTimeFormat;
	readonly rule: ScheduleRecurrence;
	constructor(rule: ScheduleRecurrence) {
		this.rule = rule;
		this.formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: rule.timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
	}
	/** A UTC-shaped number used only for local calendar arithmetic, never an instant. */
	local(at: number): number {
		const p = Object.fromEntries(this.formatter.formatToParts(at).map((p) => [p.type, p.value]));
		const d = new Date(0);
		d.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
		d.setUTCHours(Number(p.hour), Number(p.minute), 0, 0);
		return d.getTime();
	}
	day(at: number): number {
		return Math.floor(this.local(at) / DAY) * DAY;
	}
	/** First instance on folds; first valid minute after a gap (including skipped dates). */
	instant(wall: number): number {
		const offsets = new Set<number>();
		for (let h = -36; h <= 36; h += 6) {
			const t = wall + h * 3_600_000;
			offsets.add(this.local(t) - t);
		}
		const candidates = [...offsets].map((o) => wall - o).sort((a, b) => a - b);
		const exact = candidates.find((t) => this.local(t) === wall);
		if (exact !== undefined) return exact;
		for (let t = candidates[0]; t <= candidates[candidates.length - 1]; t += 60_000)
			if (this.local(t) >= wall) return t;
		throw new Error("Unrepresentable calendar time");
	}
	private matches(day: number): boolean {
		const d = new Date(day),
			weekday = d.getUTCDay() || 7;
		if (this.rule.every === "day") return !this.rule.weekdays || this.rule.weekdays.includes(weekday);
		if (this.rule.every === "week") return weekday === this.rule.weekday;
		const end = new Date(day);
		end.setUTCMonth(end.getUTCMonth() + 1, 0);
		return d.getUTCDate() === Math.min(this.rule.dayOfMonth!, end.getUTCDate());
	}
	occurrence(at: number, direction: -1 | 1): number {
		const [h, m] = this.rule.time.split(":").map(Number);
		let day = this.day(at);
		for (let n = 0; n < 65; n++, day += direction * DAY) {
			if (!this.matches(day)) continue;
			const due = this.instant(day + (h * 60 + m) * 60_000);
			if (direction === 1 ? due > at : due <= at) return due;
		}
		throw new Error("No calendar occurrence");
	}
	next(at: number): number {
		return this.occurrence(at, 1);
	}
	latest(at: number): number {
		return this.occurrence(at, -1);
	}
	periodEnd(due: number): number {
		let day = this.day(due);
		if (this.rule.every === "week") day += (7 - ((new Date(day).getUTCDay() || 7) - 1)) * DAY;
		else if (this.rule.every === "month") {
			const d = new Date(day);
			d.setUTCMonth(d.getUTCMonth() + 1, 1);
			day = d.getTime();
		} else day += DAY;
		return this.instant(day);
	}
	/** Count by calendar units, bounded even after decades offline. */
	count(after: number, through: number): number {
		const first = this.next(after);
		if (first > through) return 0;
		const a = this.day(first),
			b = this.day(through);
		if (this.rule.every === "week") return Math.floor((b - a) / (7 * DAY)) + 1;
		if (this.rule.every === "month") {
			const x = new Date(a),
				y = new Date(b);
			return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth() + 1;
		}
		const days = Math.round((b - a) / DAY) + 1;
		if (!this.rule.weekdays) return days;
		let count = Math.floor(days / 7) * this.rule.weekdays.length;
		for (let n = 0; n < days % 7; n++) if (this.matches(a + n * DAY)) count++;
		return count;
	}
}
