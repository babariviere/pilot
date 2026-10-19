/**
 * Pilot native visuals, API 1: the `ui` and `state` a visual function receives.
 *
 * A visual is a plain JavaScript function written in a codemode script and published with
 * `tools.artifact({ action: "create", kind: "visual", title, source: String(visual), data })`.
 * Pilot runs it in a sandbox (QuickJS-NG: no I/O, timers, fetch or modules) and draws the tree natively.
 * Unknown props, wrong types and bad token names fail publication with "line N: message".
 */

/** Theme token names. They follow light and dark mode. */
type Color =
	| "text"
	| "muted"
	| "accent"
	| "success"
	| "warning"
	| "danger"
	| "border"
	| "chart1"
	| "chart2"
	| "chart3"
	| "chart4"
	| "chart5"
	| "chart6";
/** Steps on the chat's type scale. Default "md". */
type TextSize = "xs" | "sm" | "md" | "lg" | "xl";
/** Default 400. */
type Weight = 400 | 500 | 600 | 700;
/** Default "start". */
type Align = "start" | "center" | "end";
/** Identity among siblings, unique within one children list (1-200 characters, or a number). */
type Key = string | number;
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

/** A node made by ui.*. Opaque: only ui functions create nodes. */
interface VisualNode {
	readonly type: string;
}
/** A styled run of text for ui.text. */
interface VisualSpan {
	readonly type: "span";
}
/**
 * Children: nodes; strings and numbers (shown as text); arrays (flattened, up to 8 levels); null, undefined and
 * booleans (skipped, so `cond && ui.text("x")` works).
 */
type Child = VisualNode | string | number | null | undefined | boolean | Child[];
type Content = string | number | VisualSpan | null | undefined | false | Content[];

interface UI {
	/** Vertical stack. Layout nodes have no fill, border or shadow. */
	column(children: Child[]): VisualNode;
	column(props: { key?: Key; gap?: number /* 0-64 pt, default 8 */; align?: Align }, children: Child[]): VisualNode;
	/** Horizontal stack. ui.space() pushes children apart. */
	row(children: Child[]): VisualNode;
	row(
		props: {
			key?: Key;
			gap?: number; // 0-64 pt, default 8
			align?: "start" | "center" | "end" | "baseline"; // vertical, default "center"
			justify?: "start" | "center" | "end" | "between"; // default "start"
		},
		children: Child[],
	): VisualNode;
	/** Equal-width columns, filled row by row. */
	grid(props: { key?: Key; columns: number /* integer 1-12 */; gap?: number }, children: Child[]): VisualNode;

	/** Selectable text. Node styles apply to every run; span styles override them. */
	text(
		content: Content,
		props?: {
			key?: Key;
			size?: TextSize;
			weight?: Weight;
			color?: Color;
			mono?: boolean;
			italic?: boolean;
			align?: Align;
			lines?: number; // line limit, integer 1-50
		},
	): VisualNode;
	span(
		text: string | number,
		props?: { weight?: Weight; color?: Color; mono?: boolean; italic?: boolean; strike?: boolean },
	): VisualSpan;

	/** One headline figure with its label. */
	stat(props: {
		key?: Key;
		label: string;
		value: string | number;
		unit?: string;
		delta?: string; // for example "+12%"
		tone?: "neutral" | "success" | "warning" | "danger"; // color of delta, default "neutral"
		caption?: string;
	}): VisualNode;

	/** Columns default to end alignment when every cell is a number. */
	table(props: {
		key?: Key;
		columns: (string | { label: string; align?: Align })[]; // 1-24
		rows: (string | number | boolean | null)[][]; // at most 500, exactly one cell per column
	}): VisualNode;

	/** Swift Charts with axes, legend and a hover readout. Series without color take chart1...chart6 in order. */
	chart(props: {
		key?: Key;
		type: "bar" | "line" | "area" | "scatter";
		x: (string | number)[]; // labels or numbers, at most 2000; numbers only for scatter
		series: { name: string; values: (number | null)[]; color?: Color }[]; // 1-12, one value per x, null is a gap
		height?: number; // 80-480 pt, default 220
		unit?: string;
		stacked?: boolean; // bar and area only
		yMin?: number;
		yMax?: number;
		xLabel?: string;
		yLabel?: string;
	}): VisualNode;

	/** Divider. */
	rule(props?: { key?: Key }): VisualNode;
	/** Fixed space (0-96 pt) along the stack; without a size, flexible space that pushes row children apart. */
	space(size?: number | { key?: Key; size?: number }): VisualNode;
	/** Opens in the browser. */
	link(label: string, props: { key?: Key; href: string /* http or https */ }): VisualNode;

	/** Segmented choice. Handlers only assign to state. */
	tabs(props: {
		key?: Key;
		options: (string | number | { value: string; label?: string })[]; // 1-12
		value: string;
		onChange: (value: string) => void;
	}): VisualNode;
	toggle(props: { key?: Key; label: string; value: boolean; onChange: (value: boolean) => void }): VisualNode;
	/** The value passed to onChange is clamped to min...max and snapped to step. */
	slider(props: {
		key?: Key;
		label?: string;
		min: number;
		max: number; // greater than min
		step?: number;
		value: number;
		unit?: string;
		onChange: (value: number) => void;
	}): VisualNode;
	button(props: { key?: Key; label: string; onClick: () => void; primary?: boolean; disabled?: boolean }): VisualNode;

	/**
	 * 2D drawing as wide as the column. draw runs on resize and pointer moves, and every display frame while animated
	 * and visible; it reads state but never assigns it. 8 ms per frame: two slow frames in a row stop the canvas.
	 */
	canvas(props: {
		key?: Key;
		height?: number; // 24-600, default 240
		animated?: boolean; // redraw every frame with t advancing
		label?: string; // describes the drawing for VoiceOver
		draw: (g: Pen, frame: Frame) => void;
	}): VisualNode;
	/**
	 * A Mermaid diagram at its natural size, shrunk to fit the column and 480 pt. source starts with a diagram type
	 * (flowchart, sequenceDiagram, classDiagram...), at most 20 KiB.
	 */
	mermaid(source: string, props?: { key?: Key }): VisualNode;
	/**
	 * A Shadertoy-style fragment shader as wide as the column, drawn with Metal. glsl defines mainImage (GLSL ES 3.00,
	 * no #version) with iResolution, iTime, iTimeDelta, iFrame and iMouse declared, plus one float uniform per input.
	 * Inputs are numbers set from state on every view, so sliders can drive the shader without republishing.
	 */
	shader(props: {
		key?: Key;
		glsl: string; // at most 16 KiB; at most 4 different shaders per visual
		inputs?: { [name: string]: number }; // up to 16; GLSL names, not i* built-ins or Metal keywords
		height?: number; // 24-600, default 240
		animated?: boolean; // default true: every frame while visible; false draws once
		label?: string; // describes the shader for VoiceOver
	}): VisualNode;
}

/** What a canvas's draw function gets with the pen. Coordinates are points from the top left. */
interface Frame {
	width: number;
	height: number;
	/** Seconds since the canvas started animating; 0 when not animated or under Reduce Motion. */
	t: number;
	/** The pointer over the canvas, or null. */
	pointer: { x: number; y: number } | null;
}

/** Shapes take fill, stroke or both (fill first). width is the stroke width, 1 by default; opacity is 0-1. */
interface Paint {
	fill?: Color;
	stroke?: Color;
	width?: number;
	opacity?: number;
}

/** Records draw commands, at most 20,000 per frame (100,000 path points, 64 KiB of text). Numbers must be finite. */
interface Pen {
	rect(x: number, y: number, w: number, h: number, paint: Paint & { radius?: number }): void;
	circle(cx: number, cy: number, r: number, paint: Paint): void;
	line(x1: number, y1: number, x2: number, y2: number, paint: Paint /* stroke only */): void;
	/** Points as [[x, y], ...] or a flat [x, y, x, y, ...]; at least 2. close joins the last point to the first. */
	path(points: number[] | [number, number][], paint: Paint & { close?: boolean }): void;
	/**
	 * Angles in radians, clockwise from 3 o'clock. Fill draws a wedge, or a ring segment when inner > 0; stroke draws
	 * the arc at r.
	 */
	arc(cx: number, cy: number, r: number, start: number, end: number, paint: Paint & { inner?: number }): void;
	/** Not wrapped. align is horizontal around x (default "start"), baseline vertical around y (default "middle"). */
	text(
		x: number,
		y: number,
		text: string | number,
		style?: {
			color?: Color; // default "text"
			size?: TextSize; // default "sm"
			weight?: Weight;
			align?: Align;
			baseline?: "top" | "middle" | "bottom";
			mono?: boolean;
			opacity?: number;
		},
	): void;
	/** save and restore bracket translate, rotate, scale and opacity (which multiplies). */
	save(): void;
	restore(): void;
	translate(x: number, y: number): void;
	rotate(radians: number): void;
	scale(x: number, y?: number): void;
	opacity(factor: number): void;
}

/**
 * Reader state: call it only while the function sets up, before returning the view. Values must be JSON. Assign to
 * the returned object in handlers (never in the view); the view runs again after each handler. Pilot saves the state
 * per artifact revision and restores it by call order when the reader comes back.
 */
type State = <T extends { [key: string]: JSONValue }>(initial: T) => T;

/**
 * The visual: runs once to set up, then returns the view, a function called after every handler. A static visual
 * may return a node (or an array, shown as a column) instead. Math.random is seeded from the artifact id and Date is
 * fixed, so a visual draws the same way everywhere. console.log lines come back in the publish result.
 */
type Visual = (context: { ui: UI; state: State; data: any /* the published data, frozen */ }) => (() => Child) | Child;
