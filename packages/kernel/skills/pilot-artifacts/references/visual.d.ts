/**
 * Pilot native visuals, API 1: the `ui` and `state` a visual function receives.
 *
 * A visual is a plain JavaScript function written in a codemode script and published with
 * `tools.artifact({ action: "create", kind: "visual", title, source: String(visual), data })`.
 * Pilot runs it in a sandbox (QuickJS-NG: no I/O, timers, fetch or modules) and draws the tree natively.
 * Unknown props, wrong types and bad token names fail publication with "line N: message".
 *
 * Tokens are defaults, not restrictions: every color also takes a literal, text takes any size, weight and the
 * embedded families, and layout nodes take fills, borders, radii, shadows, sizes and positions (Surface).
 */

/** Theme token names. They follow light and dark mode. */
type Token =
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
/** A token, or a literal "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa", which stays the same in light and dark mode. */
type Color = Token | `#${string}`;
/** Steps on the chat's type scale. Default "md". */
type TextSize = "xs" | "sm" | "md" | "lg" | "xl";
/** Default 400. Inter has 400-700 faces; others use the nearest. */
type Weight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
/** Embedded families: "ui" Inter, "display" Inter Display (semibold face), "mono" JetBrains Mono. Default "ui". */
type Font = "ui" | "display" | "mono";
/** Default "start". */
type Align = "start" | "center" | "end";
/** Identity among siblings, unique within one children list (1-200 characters, or a number). */
type Key = string | number;
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
/** Lucide icons the app embeds. ui.icon draws only these; visuals have no other image or asset source. */
type IconName =
	| "a-large-small"
	| "activity"
	| "archive"
	| "arrow-down"
	| "arrow-left"
	| "arrow-right"
	| "arrow-up"
	| "arrow-up-to-line"
	| "asterisk"
	| "ban"
	| "battery"
	| "battery-charging"
	| "battery-full"
	| "battery-low"
	| "battery-medium"
	| "battery-warning"
	| "bell"
	| "book-open"
	| "bot"
	| "building-2"
	| "calendar"
	| "case-sensitive"
	| "chart-pie"
	| "check"
	| "chevron-down"
	| "chevron-left"
	| "chevron-right"
	| "chevron-up"
	| "chevrons-up-down"
	| "circle"
	| "circle-alert"
	| "circle-check"
	| "circle-user"
	| "circle-x"
	| "clock"
	| "close"
	| "code-xml"
	| "compass"
	| "copy"
	| "corner-down-right"
	| "cpu"
	| "dash"
	| "delete"
	| "ellipsis"
	| "ellipsis-vertical"
	| "eraser"
	| "external-link"
	| "eye"
	| "eye-off"
	| "file"
	| "file-text"
	| "folder"
	| "folder-closed"
	| "folder-open"
	| "folder-plus"
	| "folders"
	| "frame"
	| "gallery-vertical-end"
	| "git-branch"
	| "git-compare"
	| "git-pull-request"
	| "github"
	| "globe"
	| "hard-drive"
	| "heart"
	| "heart-off"
	| "house"
	| "inbox"
	| "info"
	| "inspector"
	| "layers"
	| "layout-dashboard"
	| "link"
	| "list-filter"
	| "list-todo"
	| "loader"
	| "loader-circle"
	| "map"
	| "maximize"
	| "maximize-2"
	| "memory-stick"
	| "menu"
	| "message-circle-question-mark"
	| "messages-square"
	| "mic"
	| "minimize"
	| "minimize-2"
	| "minus"
	| "moon"
	| "network"
	| "palette"
	| "panel-bottom"
	| "panel-bottom-open"
	| "panel-left"
	| "panel-left-close"
	| "panel-left-open"
	| "panel-right"
	| "panel-right-close"
	| "panel-right-open"
	| "paperclip"
	| "pause"
	| "play"
	| "plus"
	| "redo"
	| "redo-2"
	| "refresh-cw"
	| "replace"
	| "resize-corner"
	| "rotate-cw"
	| "search"
	| "settings"
	| "settings-2"
	| "sort-ascending"
	| "sort-descending"
	| "square"
	| "square-pen"
	| "square-terminal"
	| "star"
	| "star-fill"
	| "star-off"
	| "sun"
	| "thumbs-down"
	| "thumbs-up"
	| "trash"
	| "triangle-alert"
	| "undo"
	| "undo-2"
	| "user"
	| "window-close"
	| "window-maximize"
	| "window-minimize"
	| "window-restore"
	| "workflow"
	| "wrench";

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

/**
 * Surface props of column, row and grid. Each is optional and draws nothing when omitted, so a plain stack stays
 * plain. Use them to build cards, panels, toolbars, phone frames and side-by-side artboards.
 */
interface Surface {
	/** Points: all sides, [vertical, horizontal] or [top, right, bottom, left]; 0-256 each. */
	padding?: number | [number, number] | [number, number, number, number];
	/**
	 * Points (0-4000) or "fill" (the parent's width or height). Default: the content's size. A point width holds in a
	 * narrower parent; add maxWidth to let it shrink, or put it in a scroll: "x" parent.
	 */
	width?: number | "fill";
	height?: number | "fill";
	minWidth?: number;
	maxWidth?: number;
	minHeight?: number;
	maxHeight?: number;
	/** Share of the parent row's or column's free space (0-100), like flex-grow; equal grows split it evenly. */
	grow?: number;
	/** Grid columns this node spans, 1-12. */
	span?: number;
	/**
	 * Points from the parent's left, top, right or bottom edge (-4000-4000). Any of them takes the node out of the
	 * flow and layers it over the parent: give the parent a height for a fixed stage.
	 */
	x?: number;
	y?: number;
	right?: number;
	bottom?: number;
	/** A color, or a linear gradient; angle in degrees, 0 up, default 180 (top to bottom). */
	fill?: Color | { from: Color; to: Color; angle?: number };
	border?: Color;
	/** 0-16 pt, default 1 with a border. */
	borderWidth?: number;
	/** Corner radius, 0-1000 pt. */
	radius?: number;
	/** A preset, or offsets, blur and spread in points (-100-100; blur 0-100); default color black at 20%. */
	shadow?: "sm" | "md" | "lg" | { x?: number; y?: number; blur?: number; spread?: number; color?: Color };
	/** 0-1, for the node and its children. */
	opacity?: number;
	/** Clip children to the (rounded) bounds. */
	clip?: boolean;
	/** Scroll children that overflow; "y" needs a height or maxHeight. */
	scroll?: "x" | "y";
	/** Default color of text and icons inside. Default: the theme's text color. */
	color?: Color;
	/** Makes the node pressable (pointer, or Enter/Space when focused). Handlers only assign to state. No hover state. */
	onClick?: () => void;
}

interface UI {
	/** Vertical stack. */
	column(children: Child[]): VisualNode;
	column(
		props: Surface & {
			key?: Key;
			gap?: number; // 0-64 pt, default 8
			align?: Align; // horizontal
			justify?: "start" | "center" | "end" | "between"; // vertical, with a height
		},
		children: Child[],
	): VisualNode;
	/** Horizontal stack. ui.space() pushes children apart. */
	row(children: Child[]): VisualNode;
	row(
		props: Surface & {
			key?: Key;
			gap?: number; // 0-64 pt, default 8
			align?: "start" | "center" | "end" | "baseline"; // vertical, default "center"
			justify?: "start" | "center" | "end" | "between"; // default "start"
			wrap?: boolean; // wrap children onto more lines when they don't fit, default true
		},
		children: Child[],
	): VisualNode;
	/** Equal-width columns, filled row by row. */
	grid(
		props: Surface & { key?: Key; columns: number /* integer 1-12 */; gap?: number },
		children: Child[],
	): VisualNode;

	/** Selectable text. Node styles apply to every run; span styles override them. */
	text(
		content: Content,
		props?: {
			key?: Key;
			size?: TextSize | number; // a step, or 6-200 pt
			weight?: Weight;
			color?: Color; // default: the surface's color
			font?: Font;
			mono?: boolean; // the same as font: "mono"
			italic?: boolean;
			align?: Align;
			lines?: number; // line limit, integer 1-50
			lineHeight?: number; // multiple of the size, 0.8-3, default 1.618
		},
	): VisualNode;
	span(
		text: string | number,
		props?: { weight?: Weight; color?: Color; font?: Font; mono?: boolean; italic?: boolean; strike?: boolean },
	): VisualSpan;
	/** A bundled Lucide icon, square. */
	icon(name: IconName, props?: { key?: Key; size?: number /* 8-128 pt, default 16 */; color?: Color }): VisualNode;
	/**
	 * A fixed drawing in width x height units: logos, illustrations, avatars, custom glyphs, decorative shapes. draw
	 * runs while the view renders (it reads state, never assigns it) and records pen commands, which the app plans
	 * once and paints natively. It shows at width x height, shrunk proportionally to fit a narrower parent. All
	 * vectors in one view share the canvas budget of 20,000 commands. Use ui.canvas for pointer-driven or animated
	 * drawings.
	 */
	vector(props: {
		key?: Key;
		width: number; // 1-2000
		height: number; // 1-2000
		label?: string; // describes the drawing for VoiceOver
		draw: (g: Pen, size: { width: number; height: number }) => void;
	}): VisualNode;

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
		width?: number; // 1-2000, default the column's width (never wider)
		height?: number; // 24-600, default 240
		animated?: boolean; // redraw every frame with t advancing
		label?: string; // describes the drawing for VoiceOver
		draw: (g: Pen, frame: Frame) => void;
	}): VisualNode;
	/**
	 * A bounded native flowchart/graph subset, at most20KiB UTF-8. Check/publication rejects invalid,
	 * unsupported and over-limit source distinctly. No browser fallback; see visuals.md for syntax and limits.
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
	/**
	 * Points as [[x, y], ...] or a flat [x, y, x, y, ...], at least 2; or SVG path data such as "M4 4h16v16H4z"
	 * (M L H V C S Q T A Z, relative lowercase too), whose subpaths fill together with the nonzero rule, so cut-outs
	 * stay open. Curves become short segments. close joins the last point to the first.
	 */
	path(points: number[] | [number, number][] | string, paint: Paint & { close?: boolean }): void;
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
