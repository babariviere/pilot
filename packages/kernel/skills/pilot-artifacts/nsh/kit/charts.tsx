// Charts drawn from declarative data. Every number a chart shows is also
// written as text, so the chart never carries meaning by shape or color alone.
import { Canvas, type CanvasRenderingContext2D, Text, token, View } from "nsh";
import { attempt, choice, finite, list, optionalText, Problem, record, text } from "./check";
import { DataProblem, MAX_TEXT_SCALE, outcome } from "./ui";

export const CHART_LIMITS = { bars: 50, points: 400, events: 50, label: 60, detail: 160 } as const;

const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** A number as the chart writes it, with its unit. */
export function formatValue(value: number, unit?: string): string {
	const shown = numbers.format(value);
	return unit ? `${shown} ${unit}` : shown;
}

export interface Bar {
	label: string;
	value: number;
}

export interface BarSpec {
	bars: readonly Bar[];
	/** Written after each value: "ms", "tests", "%". */
	unit?: string;
}

function readBars(spec: unknown): BarSpec {
	const data = record(spec, "The chart");
	const unit = optionalText(data.unit, "unit", 16);
	const bars = list(data.bars, "bars", 1, CHART_LIMITS.bars).map((value, i) => {
		const bar = record(value, `bars[${i}]`);
		const label = text(bar.label, `bars[${i}].label`, CHART_LIMITS.label);
		const amount = finite(bar.value, `Bar "${label}" value`);
		if (amount < 0) throw new Problem(`Bar "${label}" is negative; bars start at zero.`);
		return { label, value: amount };
	});
	return { bars, unit };
}

/** Horizontal bars from zero, each with its value written beside it. */
export function BarChart(props: { spec: BarSpec }) {
	const chart = outcome(() => attempt(() => readBars(props.spec)));
	const top = () => Math.max(...(chart.value()?.bars ?? []).map((b) => b.value), 0);
	return (
		<If when={chart.value()} else={<DataProblem what="chart" problem={chart.problem()} />}>
			{(c) => (
				<View class="gap-2.5">
					<Each of={c().bars} key="index">
						{(bar) => (
							<View
								class="flex-row items-center gap-3"
								accessible
								accessibilityLabel={`${bar().label}: ${formatValue(bar().value, c().unit)}`}
							>
								<Text
									class="w-36 text-sm text-foreground"
									style={{ numberOfLines: 2 }}
									maxFontSizeMultiplier={MAX_TEXT_SCALE}
								>
									{bar().label}
								</Text>
								<View class="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
									<View
										class="h-full rounded-full bg-primary"
										style={{ width: `${top() > 0 ? (bar().value / top()) * 100 : 0}%` }}
									/>
								</View>
								<Text class="w-24 text-right text-sm tabular-nums text-muted-foreground">
									{formatValue(bar().value, c().unit)}
								</Text>
							</View>
						)}
					</Each>
				</View>
			)}
		</If>
	);
}

export interface TrendPoint {
	label: string;
	value: number;
}

export interface TrendSpec {
	points: readonly TrendPoint[];
	unit?: string;
}

function readTrend(spec: unknown): TrendSpec {
	const data = record(spec, "The chart");
	const unit = optionalText(data.unit, "unit", 16);
	const points = list(data.points, "points", 2, CHART_LIMITS.points).map((value, i) => {
		const point = record(value, `points[${i}]`);
		const label = text(point.label, `points[${i}].label`, CHART_LIMITS.label);
		return { label, value: finite(point.value, `Point "${label}" value`) };
	});
	return { points, unit };
}

function drawTrend(cx: CanvasRenderingContext2D, width: number, height: number, points: readonly TrendPoint[]) {
	const values = points.map((p) => p.value);
	const low = Math.min(...values);
	const high = Math.max(...values);
	const pad = 8;
	const x = (i: number) => pad + (i / (points.length - 1)) * (width - 2 * pad);
	const y = (v: number) => (high === low ? height / 2 : pad + (1 - (v - low) / (high - low)) * (height - 2 * pad));
	cx.strokeStyle = token("border");
	cx.lineWidth = 1;
	cx.beginPath();
	cx.moveTo(pad, height - pad);
	cx.lineTo(width - pad, height - pad);
	cx.stroke();
	cx.beginPath();
	points.forEach((p, i) => {
		if (i === 0) cx.moveTo(x(i), y(p.value));
		else cx.lineTo(x(i), y(p.value));
	});
	cx.strokeStyle = token("primary");
	cx.lineWidth = 2;
	cx.lineJoin = "round";
	cx.lineCap = "round";
	cx.stroke();
	const last = points.length - 1;
	cx.fillStyle = token("primary");
	cx.beginPath();
	cx.arc(x(last), y(points[last].value), 3.5, 0, Math.PI * 2);
	cx.fill();
}

/** A line over time, with its low, high and latest values written above it. */
export function TrendChart(props: { spec: TrendSpec; height?: number }) {
	const chart = outcome(() => attempt(() => readTrend(props.spec)));
	return (
		<If when={chart.value()} else={<DataProblem what="chart" problem={chart.problem()} />}>
			{(c) => {
				const values = () => c().points.map((p) => p.value);
				const first = () => c().points[0];
				const last = () => c().points[c().points.length - 1];
				const facts = () =>
					`Low ${formatValue(Math.min(...values()), c().unit)} · High ${formatValue(Math.max(...values()), c().unit)} · Latest ${formatValue(last().value, c().unit)}`;
				return (
					<View class="gap-2">
						<Text class="text-xs tabular-nums text-muted-foreground">{facts()}</Text>
						<Canvas
							style={{ height: props.height ?? 160 }}
							accessible
							accessibilityLabel={`Trend from ${first().label} (${formatValue(first().value, c().unit)}) to ${last().label} (${formatValue(last().value, c().unit)}). ${facts()}.`}
							draw={(cx, size) => drawTrend(cx, size.width, size.height, c().points)}
						/>
						<View class="flex-row justify-between">
							<Text class="text-xs text-muted-foreground">{first().label}</Text>
							<Text class="text-xs text-muted-foreground">{last().label}</Text>
						</View>
					</View>
				);
			}}
		</If>
	);
}

export type EventState = "done" | "now" | "next";
const STATES: readonly EventState[] = ["done", "now", "next"];
const STATE_WORDS: Record<EventState, string> = { done: "Done", now: "Now", next: "Next" };

export interface TimelineEvent {
	when: string;
	title: string;
	detail?: string;
	state?: EventState;
}

function readTimeline(spec: unknown): { events: TimelineEvent[] } {
	const data = record(spec, "The timeline");
	const events = list(data.events, "events", 1, CHART_LIMITS.events).map((value, i) => {
		const event = record(value, `events[${i}]`);
		const title = text(event.title, `events[${i}].title`, CHART_LIMITS.label);
		return {
			when: text(event.when, `Event "${title}" when`, 40),
			title,
			detail: optionalText(event.detail, `Event "${title}" detail`, CHART_LIMITS.detail),
			state: choice(event.state, `Event "${title}" state`, STATES, "next"),
		};
	});
	return { events };
}

/** Events in order, top to bottom. Each state is written as a word beside its mark. */
export function Timeline(props: { spec: { events: readonly TimelineEvent[] } }) {
	const timeline = outcome(() => attempt(() => readTimeline(props.spec)));
	return (
		<If when={timeline.value()} else={<DataProblem what="timeline" problem={timeline.problem()} />}>
			{(t) => (
				<View>
					<Each of={t().events} key="index">
						{(event, i) => {
							const state = () => event().state ?? "next";
							return (
								<View class="flex-row gap-3">
									<Text class="w-24 pt-0.5 text-xs tabular-nums text-muted-foreground">{event().when}</Text>
									<View class="w-3 items-center">
										<View
											class={`mt-1.5 size-2.5 rounded-full ${state() === "next" ? "border border-muted-foreground bg-background" : "bg-primary"}`}
										/>
										<If when={i() < t().events.length - 1}>
											<View class="w-px flex-1 bg-border" />
										</If>
									</View>
									<View class="flex-1 gap-0.5 pb-4">
										<View class="flex-row items-baseline gap-2">
											<Text class="text-sm font-medium text-foreground">{event().title}</Text>
											<Text
												class={`text-xs ${state() === "now" ? "text-primary" : "text-muted-foreground"}`}
											>
												{STATE_WORDS[state()]}
											</Text>
										</View>
										<If when={event().detail}>
											<Text class="text-sm text-muted-foreground">{event().detail}</Text>
										</If>
									</View>
								</View>
							);
						}}
					</Each>
				</View>
			)}
		</If>
	);
}
