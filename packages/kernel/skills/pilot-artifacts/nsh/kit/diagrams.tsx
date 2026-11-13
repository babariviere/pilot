// FlowDiagram and SequenceDiagram: declarative data in, a laid-out native
// drawing out. Boxes and labels are native text views (readable by screen
// readers and selectable); lines and arrows are drawn on a canvas beneath.
import { Canvas, type CanvasRenderingContext2D, Scroll, Text, token, View } from "nsh";
import { type FlowLayout, type FlowSpec, layoutFlow, type PlacedEdge, type Point, type Tone } from "./flow";
import {
	layoutSequence,
	type PlacedMessage,
	type PlacedNote,
	type SequenceLayout,
	type SequenceSpec,
} from "./sequence";
import { textWidth } from "./text";
import { DataProblem, MAX_TEXT_SCALE, outcome, textScale } from "./ui";

const ARROW = { length: 8, half: 4.5 } as const;
const CORNER = 6;

const TONE_CLASS: Record<Tone, string> = {
	default: "border-border bg-card",
	accent: "border-primary bg-card",
	muted: "border-border bg-muted",
	danger: "border-destructive bg-card",
};

function back(p: Point, angle: number, by: number): Point {
	return { x: p.x - Math.cos(angle) * by, y: p.y - Math.sin(angle) * by };
}

function arrowHead(cx: CanvasRenderingContext2D, tip: Point, angle: number) {
	const base = back(tip, angle, ARROW.length);
	const nx = -Math.sin(angle) * ARROW.half;
	const ny = Math.cos(angle) * ARROW.half;
	cx.beginPath();
	cx.moveTo(tip.x, tip.y);
	cx.lineTo(base.x + nx, base.y + ny);
	cx.lineTo(base.x - nx, base.y - ny);
	cx.closePath();
	cx.fill();
}

/** Straight segments with softly rounded corners, ending where the arrow head starts. */
function route(cx: CanvasRenderingContext2D, path: readonly Point[], end: Point) {
	cx.moveTo(path[0].x, path[0].y);
	for (let i = 1; i < path.length - 1; i++) cx.arcTo(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y, CORNER);
	cx.lineTo(end.x, end.y);
}

function drawEdge(cx: CanvasRenderingContext2D, edge: PlacedEdge) {
	const end = back(edge.tip, edge.angle, ARROW.length - 1);
	cx.setLineDash(edge.dashed ? [5, 4] : []);
	cx.beginPath();
	if (edge.kind === "curve") {
		const [start, c1, c2] = edge.path;
		cx.moveTo(start.x, start.y);
		cx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
	} else {
		route(cx, edge.path, end);
	}
	cx.stroke();
	cx.setLineDash([]);
	arrowHead(cx, edge.tip, edge.angle);
}

function drawFlow(cx: CanvasRenderingContext2D, layout: FlowLayout) {
	const ink = token("muted-foreground");
	cx.strokeStyle = ink;
	cx.fillStyle = ink;
	cx.lineWidth = 1.25;
	for (const edge of layout.edges) drawEdge(cx, edge);
}

/**
 * Steps and the links between them, laid out for you: architecture, a process,
 * a pipeline. Loops (links back against the flow) are routed around the steps.
 * Wider than its space, it scrolls sideways.
 */
export function FlowDiagram(props: { spec: FlowSpec }) {
	const flow = outcome(() => layoutFlow(props.spec, textScale()));
	return (
		<If when={flow.value()} else={<DataProblem what="diagram" problem={flow.problem()} />}>
			{(l) => (
				<Scroll horizontal style={{ height: l().height }}>
					<View
						style={{ width: l().width, height: l().height }}
						accessible
						accessibilityLabel={l().summary}
						testID="flow-diagram"
					>
						<Canvas
							style={{ position: "absolute", left: 0, top: 0, width: l().width, height: l().height }}
							draw={(cx) => drawFlow(cx, l())}
						/>
						<Each of={l().edges.filter((e) => e.labelAt)} key="index">
							{(edge) => {
								const size = () => textScale();
								const width = () => Math.ceil(textWidth(edge().label ?? "", 12 * size())) + 12;
								const height = () => Math.ceil(16 * size()) + 4;
								return (
									<View
										class="items-center justify-center rounded-sm bg-background px-1.5"
										style={{
											position: "absolute",
											left: (edge().labelAt?.x ?? 0) - width() / 2,
											top: (edge().labelAt?.y ?? 0) - height() / 2,
											width: width(),
											height: height(),
										}}
									>
										<Text
											class="text-xs text-muted-foreground"
											style={{ numberOfLines: 1 }}
											maxFontSizeMultiplier={MAX_TEXT_SCALE}
										>
											{edge().label ?? ""}
										</Text>
									</View>
								);
							}}
						</Each>
						<Each of={l().nodes} key={(n) => n.id}>
							{(node) => (
								<View
									class={`justify-center gap-0.5 rounded-lg border px-3 py-2.5 ${TONE_CLASS[node().tone]}`}
									style={{
										position: "absolute",
										left: node().x,
										top: node().y,
										width: node().width,
										height: node().height,
									}}
								>
									<Text
										class="text-sm font-medium text-card-foreground"
										style={{ numberOfLines: node().labelLines }}
										maxFontSizeMultiplier={MAX_TEXT_SCALE}
									>
										{node().label}
									</Text>
									<If when={node().detail}>
										<Text
											class="text-xs text-muted-foreground"
											style={{ numberOfLines: node().detailLines }}
											maxFontSizeMultiplier={MAX_TEXT_SCALE}
										>
											{node().detail ?? ""}
										</Text>
									</If>
								</View>
							)}
						</Each>
					</View>
				</Scroll>
			)}
		</If>
	);
}

function drawSequence(cx: CanvasRenderingContext2D, layout: SequenceLayout) {
	const ink = token("muted-foreground");
	cx.strokeStyle = token("border");
	cx.lineWidth = 1;
	cx.setLineDash([3, 3]);
	for (const p of layout.participants) {
		cx.beginPath();
		cx.moveTo(p.x, layout.lifeline.top);
		cx.lineTo(p.x, layout.lifeline.bottom);
		cx.stroke();
	}
	cx.strokeStyle = ink;
	cx.fillStyle = ink;
	cx.lineWidth = 1.25;
	for (const step of layout.steps) {
		if (step.kind !== "message") continue;
		const end = back(step.tip, step.angle, ARROW.length - 1);
		cx.setLineDash(step.dashed ? [5, 4] : []);
		cx.beginPath();
		route(cx, step.path, end);
		cx.stroke();
		cx.setLineDash([]);
		arrowHead(cx, step.tip, step.angle);
	}
}

function NoteBox(props: { note: PlacedNote }) {
	return (
		<View
			class="justify-center rounded-md border border-border bg-muted px-2"
			style={{
				position: "absolute",
				left: props.note.box.x,
				top: props.note.box.y,
				width: props.note.box.width,
				height: props.note.box.height,
			}}
		>
			<Text
				class="text-xs text-foreground"
				style={{ numberOfLines: props.note.lines }}
				maxFontSizeMultiplier={MAX_TEXT_SCALE}
			>
				{props.note.note}
			</Text>
		</View>
	);
}

function MessageLabel(props: { message: PlacedMessage }) {
	return (
		<Text
			class={`text-xs text-foreground ${props.message.self ? "" : "text-center"}`}
			maxFontSizeMultiplier={MAX_TEXT_SCALE}
			style={{
				numberOfLines: props.message.text.lines,
				position: "absolute",
				left: props.message.text.x,
				top: props.message.text.y,
				width: props.message.text.width,
			}}
		>
			{props.message.label}
		</Text>
	);
}

/** Who sends what to whom, in order: requests, replies and notes. Wider than its space, it scrolls sideways. */
export function SequenceDiagram(props: { spec: SequenceSpec }) {
	const sequence = outcome(() => layoutSequence(props.spec, textScale()));
	return (
		<If when={sequence.value()} else={<DataProblem what="diagram" problem={sequence.problem()} />}>
			{(l) => (
				<Scroll horizontal style={{ height: l().height }}>
					<View
						style={{ width: l().width, height: l().height }}
						accessible
						accessibilityLabel={l().summary}
						testID="sequence-diagram"
					>
						<Canvas
							style={{ position: "absolute", left: 0, top: 0, width: l().width, height: l().height }}
							draw={(cx) => drawSequence(cx, l())}
						/>
						<Each of={l().participants} key={(p) => p.id}>
							{(p) => (
								<View
									class="items-center justify-center rounded-lg border border-border bg-card px-2.5 py-2"
									style={{
										position: "absolute",
										left: p().box.x,
										top: p().box.y,
										width: p().box.width,
										height: p().box.height,
									}}
								>
									<Text
										class="text-center text-sm font-medium text-card-foreground"
										style={{ numberOfLines: p().lines }}
										maxFontSizeMultiplier={MAX_TEXT_SCALE}
									>
										{p().label}
									</Text>
								</View>
							)}
						</Each>
						<Each of={l().steps} key="index">
							{(step) => {
								const note = () => {
									const s = step();
									return s.kind === "note" ? s : undefined;
								};
								const message = () => {
									const s = step();
									return s.kind === "message" ? s : undefined;
								};
								return (
									<If when={note()} else={<MessageLabel message={message()!} />}>
										{(n) => <NoteBox note={n()} />}
									</If>
								);
							}}
						</Each>
					</View>
				</Scroll>
			)}
		</If>
	);
}
