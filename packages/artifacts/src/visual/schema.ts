/**
 * Node tree of native agent visuals, API version 1. This file is the single source of truth: the JSON Schema
 * in packages/protocol/fixtures/visual/api-1.schema.json is generated from it (a test keeps them identical),
 * and the app decodes the same trees. The runtime (runtime.js) produces these trees; the pre-check validates
 * every tree it sees against this schema as well.
 */
import Type, { type Static } from "typebox";

export const VISUAL_API_VERSION = 1;

/** Limits from docs/technical/native-visuals.md. The runtime enforces the tree, state and log limits itself. */
export const VISUAL_LIMITS = Object.freeze({
	/** UTF-8 bytes of the function's source text. */
	sourceBytes: 256 * 1024,
	/** UTF-8 bytes of `data` as JSON. */
	dataBytes: 1024 * 1024,
	heapBytes: 32 * 1024 * 1024,
	stackBytes: 512 * 1024,
	setupMs: 250,
	viewMs: 250,
	handlerMs: 100,
	/** One canvas draw: one 120 Hz frame. In the app, two misses in a row stop the canvas with the error. */
	drawMs: 8,
	/** Nodes in one tree. */
	nodes: 5000,
	/** UTF-16 code units of text in one tree (labels, runs, cells, options). */
	textChars: 64 * 1024,
	/** UTF-16 code units of the saved state as JSON. */
	stateChars: 64 * 1024,
	/** Interactions the pre-check exercises. */
	interactions: 24,
	/** console lines kept per check, and characters per line. */
	logLines: 50,
	logLineChars: 500,
	/** Commands one canvas draw may record. */
	drawCommands: 20_000,
	/** Path points one canvas draw may record. */
	drawPoints: 100_000,
	/** UTF-16 code units of text one canvas draw may record. */
	drawTextChars: 64 * 1024,
	/** Canvas draws the pre-check runs, across every view it renders. */
	checkedDraws: 96,
	/** UTF-16 code units of one shader's GLSL. */
	shaderChars: 16 * 1024,
	/** Named number inputs of one shader. */
	shaderInputs: 16,
	/** Different shaders (GLSL and input names) one visual may show across its views. */
	shaders: 4,
	/** UTF-16 code units of one Mermaid source. They also count toward the tree's text. */
	mermaidChars: 20 * 1024,
});

export const VISUAL_COLORS = [
	"text",
	"muted",
	"accent",
	"success",
	"warning",
	"danger",
	"border",
	"chart1",
	"chart2",
	"chart3",
	"chart4",
	"chart5",
	"chart6",
] as const;
export const VISUAL_TEXT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export const VISUAL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
/** Embedded families: Inter (ui), Inter Display (display) and JetBrains Mono (mono). */
export const VISUAL_FONTS = ["ui", "display", "mono"] as const;
/** Lucide icons the app embeds; ui.icon accepts exactly these names. */
export const VISUAL_ICONS = [
	"a-large-small",
	"activity",
	"archive",
	"arrow-down",
	"arrow-left",
	"arrow-right",
	"arrow-up",
	"arrow-up-to-line",
	"asterisk",
	"ban",
	"battery",
	"battery-charging",
	"battery-full",
	"battery-low",
	"battery-medium",
	"battery-warning",
	"bell",
	"book-open",
	"bot",
	"building-2",
	"calendar",
	"case-sensitive",
	"chart-pie",
	"check",
	"chevron-down",
	"chevron-left",
	"chevron-right",
	"chevron-up",
	"chevrons-up-down",
	"circle",
	"circle-alert",
	"circle-check",
	"circle-user",
	"circle-x",
	"clock",
	"close",
	"code-xml",
	"compass",
	"copy",
	"corner-down-right",
	"cpu",
	"dash",
	"delete",
	"ellipsis",
	"ellipsis-vertical",
	"eraser",
	"external-link",
	"eye",
	"eye-off",
	"file",
	"file-text",
	"folder",
	"folder-closed",
	"folder-open",
	"folder-plus",
	"folders",
	"frame",
	"gallery-vertical-end",
	"git-branch",
	"git-compare",
	"git-pull-request",
	"github",
	"globe",
	"hard-drive",
	"heart",
	"heart-off",
	"house",
	"inbox",
	"info",
	"inspector",
	"layers",
	"layout-dashboard",
	"link",
	"list-filter",
	"list-todo",
	"loader",
	"loader-circle",
	"map",
	"maximize",
	"maximize-2",
	"memory-stick",
	"menu",
	"message-circle-question-mark",
	"messages-square",
	"mic",
	"minimize",
	"minimize-2",
	"minus",
	"moon",
	"network",
	"palette",
	"panel-bottom",
	"panel-bottom-open",
	"panel-left",
	"panel-left-close",
	"panel-left-open",
	"panel-right",
	"panel-right-close",
	"panel-right-open",
	"paperclip",
	"pause",
	"play",
	"plus",
	"redo",
	"redo-2",
	"refresh-cw",
	"replace",
	"resize-corner",
	"rotate-cw",
	"search",
	"settings",
	"settings-2",
	"sort-ascending",
	"sort-descending",
	"square",
	"square-pen",
	"square-terminal",
	"star",
	"star-fill",
	"star-off",
	"sun",
	"thumbs-down",
	"thumbs-up",
	"trash",
	"triangle-alert",
	"undo",
	"undo-2",
	"user",
	"window-close",
	"window-maximize",
	"window-minimize",
	"window-restore",
	"workflow",
	"wrench",
] as const;

const strict = { additionalProperties: false } as const;
const Key = Type.String({
	minLength: 1,
	maxLength: 200,
	description: "Identity among siblings, unique within one children list. Numbers become strings.",
});
const Id = Type.String({
	pattern: "^0(\\.[0-9]+)*$",
	description:
		"Controls only: the node's path of child indices from the root (root is 0). The host sends events to this id.",
});
const Token = Type.Enum([...VISUAL_COLORS], { description: "Theme token name. Values follow light and dark mode." });
const Color = Type.Union(
	[
		Token,
		Type.String({
			pattern: "^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
			description: "Literal #rgb, #rgba, #rrggbb or #rrggbbaa. The same in light and dark mode.",
		}),
	],
	{ description: "A theme token or a literal color." },
);
const Size = Type.Union(
	[
		Type.Enum([...VISUAL_TEXT_SIZES], { description: "Step on the chat's type scale." }),
		Type.Number({ minimum: 6, maximum: 200, description: "Points." }),
	],
	{ description: "Default md." },
);
const Font = Type.Enum([...VISUAL_FONTS], { description: "Embedded family. Default ui." });
const Weight = Type.Enum([...VISUAL_WEIGHTS], { description: "Font weight. Default 400." });
const Gap = Type.Number({ minimum: 0, maximum: 64, description: "Spacing between children in points." });
const Length = Type.Number({ minimum: 0, maximum: 4000 });
const Offset = Type.Number({ minimum: -4000, maximum: 4000 });
const Justify = Type.Enum(["start", "center", "end", "between"], {
	description: "Distribution along the stack. Default start; between spreads children to both edges.",
});
const Text = Type.String({ maxLength: 10_000 });
const Label = Type.String({ maxLength: 500 });

/** Surface props of column, row and grid. Omitted props draw nothing: no fill, border, shadow or padding. */
const surface = {
	padding: Type.Optional(
		Type.Array(Type.Number({ minimum: 0, maximum: 256 }), {
			minItems: 4,
			maxItems: 4,
			description: "Top, right, bottom, left in points.",
		}),
	),
	width: Type.Optional(Type.Union([Length, Type.Literal("fill")], { description: "Points, or fill the parent." })),
	height: Type.Optional(Type.Union([Length, Type.Literal("fill")], { description: "Points, or fill the parent." })),
	minWidth: Type.Optional(Length),
	maxWidth: Type.Optional(Length),
	minHeight: Type.Optional(Length),
	maxHeight: Type.Optional(Length),
	grow: Type.Optional(
		Type.Number({ minimum: 0, maximum: 100, description: "Share of the parent stack's free space." }),
	),
	span: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Grid columns this node spans." })),
	x: Type.Optional(Offset),
	y: Type.Optional(Offset),
	right: Type.Optional(Offset),
	bottom: Type.Optional(Offset),
	fill: Type.Optional(
		Type.Union([
			Color,
			Type.Object(
				{
					from: Color,
					to: Color,
					angle: Type.Optional(
						Type.Number({ minimum: 0, maximum: 360, description: "Degrees; 0 is up. Default 180." }),
					),
				},
				{ ...strict, description: "Linear gradient." },
			),
		]),
	),
	border: Type.Optional(Color),
	borderWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 16, description: "Default 1 with a border." })),
	radius: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
	shadow: Type.Optional(
		Type.Union([
			Type.Enum(["sm", "md", "lg"]),
			Type.Object(
				{
					x: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
					y: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
					blur: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
					spread: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
					color: Type.Optional(Color),
				},
				strict,
			),
		]),
	),
	opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	clip: Type.Optional(Type.Boolean({ description: "Clip children to the rounded bounds." })),
	scroll: Type.Optional(
		Type.Enum(["x", "y"], { description: "Scroll overflowing children; y needs height or maxHeight." }),
	),
	color: Type.Optional(Color),
	id: Type.Optional(
		Type.String({
			pattern: "^0(\\.[0-9]+)*$",
			description: "Present when the visual set onClick: the node is pressable. Event value: null.",
		}),
	),
};

const Run = Type.Object(
	{
		text: Text,
		weight: Type.Optional(Weight),
		color: Type.Optional(Color),
		font: Type.Optional(Font),
		mono: Type.Optional(Type.Boolean()),
		italic: Type.Optional(Type.Boolean()),
		strike: Type.Optional(Type.Boolean()),
	},
	{ ...strict, description: "A run of text with its own style, from a string or ui.span()." },
);

const Children = Type.Array(Type.Ref("Node"));

const nodes = {
	Column: Type.Object(
		{
			type: Type.Literal("column"),
			key: Type.Optional(Key),
			gap: Type.Optional(Gap),
			align: Type.Optional(Type.Enum(["start", "center", "end"], { description: "Horizontal. Default start." })),
			justify: Type.Optional(Justify),
			...surface,
			children: Children,
		},
		{ ...strict, description: "Vertical stack, with optional surface styling." },
	),
	Row: Type.Object(
		{
			type: Type.Literal("row"),
			key: Type.Optional(Key),
			gap: Type.Optional(Gap),
			align: Type.Optional(
				Type.Enum(["start", "center", "end", "baseline"], { description: "Vertical. Default center." }),
			),
			justify: Type.Optional(Justify),
			wrap: Type.Optional(Type.Boolean({ description: "Wrap children onto more lines. Default true." })),
			...surface,
			children: Children,
		},
		{ ...strict, description: "Horizontal stack, with optional surface styling." },
	),
	Grid: Type.Object(
		{
			type: Type.Literal("grid"),
			key: Type.Optional(Key),
			columns: Type.Integer({ minimum: 1, maximum: 12 }),
			gap: Type.Optional(Gap),
			...surface,
			children: Children,
		},
		{ ...strict, description: "Equal-width columns, filled row by row." },
	),
	Text: Type.Object(
		{
			type: Type.Literal("text"),
			key: Type.Optional(Key),
			runs: Type.Array(Run, { maxItems: 500 }),
			size: Type.Optional(Size),
			weight: Type.Optional(Weight),
			color: Type.Optional(Color),
			font: Type.Optional(Font),
			mono: Type.Optional(Type.Boolean()),
			italic: Type.Optional(Type.Boolean()),
			align: Type.Optional(Type.Enum(["start", "center", "end"], { description: "Default start." })),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Line limit. Default none." })),
			lineHeight: Type.Optional(
				Type.Number({ minimum: 0.8, maximum: 3, description: "Multiple of the size. Default 1.618." }),
			),
		},
		{ ...strict, description: "Selectable text. Node styles apply to every run; run styles override them." },
	),
	Stat: Type.Object(
		{
			type: Type.Literal("stat"),
			key: Type.Optional(Key),
			label: Label,
			value: Label,
			unit: Type.Optional(Label),
			delta: Type.Optional(Label),
			tone: Type.Optional(
				Type.Enum(["neutral", "success", "warning", "danger"], { description: "Color of delta. Default neutral." }),
			),
			caption: Type.Optional(Label),
		},
		{ ...strict, description: "One headline figure with its label." },
	),
	Table: Type.Object(
		{
			type: Type.Literal("table"),
			key: Type.Optional(Key),
			columns: Type.Array(
				Type.Object(
					{
						label: Label,
						align: Type.Optional(
							Type.Enum(["start", "center", "end"], {
								description: "Default end when every cell in the column is a number, else start.",
							}),
						),
					},
					strict,
				),
				{ minItems: 1, maxItems: 24 },
			),
			rows: Type.Array(Type.Array(Type.Union([Text, Type.Number(), Type.Null()])), {
				maxItems: 500,
				description: "Each row has exactly one cell per column. Null shows an empty cell.",
			}),
		},
		strict,
	),
	Chart: Type.Object(
		{
			type: Type.Literal("chart"),
			key: Type.Optional(Key),
			kind: Type.Enum(["bar", "line", "area", "scatter"]),
			x: Type.Array(Type.Union([Label, Type.Number()]), {
				maxItems: 2000,
				description: "Category labels or numbers. Numbers only for scatter.",
			}),
			series: Type.Array(
				Type.Object(
					{
						name: Label,
						values: Type.Array(Type.Union([Type.Number(), Type.Null()]), {
							maxItems: 2000,
							description: "One value per x entry. Null is a gap.",
						}),
						color: Type.Optional(Color),
					},
					strict,
				),
				{ minItems: 1, maxItems: 12 },
			),
			height: Type.Number({ minimum: 80, maximum: 480, description: "Plot height in points. Default 220." }),
			unit: Type.Optional(Label),
			stacked: Type.Optional(Type.Boolean({ description: "Bar and area only." })),
			yMin: Type.Optional(Type.Number()),
			yMax: Type.Optional(Type.Number()),
			xLabel: Type.Optional(Label),
			yLabel: Type.Optional(Label),
		},
		{ ...strict, description: "Swift Charts. Series without color take chart1...chart6 in order." },
	),
	Rule: Type.Object({ type: Type.Literal("rule"), key: Type.Optional(Key) }, { ...strict, description: "Divider." }),
	Space: Type.Object(
		{
			type: Type.Literal("space"),
			key: Type.Optional(Key),
			size: Type.Optional(
				Type.Number({ minimum: 0, maximum: 96, description: "Fixed size in points. Omitted: flexible." }),
			),
		},
		strict,
	),
	Link: Type.Object(
		{
			type: Type.Literal("link"),
			key: Type.Optional(Key),
			label: Label,
			href: Type.String({ maxLength: 2048, pattern: "^https?://", description: "http or https only." }),
		},
		strict,
	),
	Tabs: Type.Object(
		{
			type: Type.Literal("tabs"),
			key: Type.Optional(Key),
			id: Id,
			options: Type.Array(Type.Object({ value: Label, label: Label }, strict), { minItems: 1, maxItems: 12 }),
			value: Label,
		},
		{ ...strict, description: "Segmented choice. Event value: the chosen option's value (string)." },
	),
	Toggle: Type.Object(
		{ type: Type.Literal("toggle"), key: Type.Optional(Key), id: Id, label: Label, value: Type.Boolean() },
		{ ...strict, description: "Event value: the new boolean." },
	),
	Slider: Type.Object(
		{
			type: Type.Literal("slider"),
			key: Type.Optional(Key),
			id: Id,
			label: Type.Optional(Label),
			min: Type.Number(),
			max: Type.Number(),
			step: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			value: Type.Number(),
			unit: Type.Optional(Label),
		},
		{
			...strict,
			description:
				"min < max and min <= value <= max. Event value: a number; the runtime clamps it and snaps it to step.",
		},
	),
	Button: Type.Object(
		{
			type: Type.Literal("button"),
			key: Type.Optional(Key),
			id: Id,
			label: Label,
			primary: Type.Optional(Type.Boolean()),
			disabled: Type.Optional(Type.Boolean()),
		},
		{ ...strict, description: "Event value: null." },
	),
	Canvas: Type.Object(
		{
			type: Type.Literal("canvas"),
			key: Type.Optional(Key),
			id: Id,
			width: Type.Optional(
				Type.Number({ minimum: 1, maximum: 2000, description: "Width in points. Default the column's width." }),
			),
			height: Type.Number({ minimum: 24, maximum: 600, description: "Height in points. Default 240." }),
			animated: Type.Optional(
				Type.Boolean({ description: "Redraw every display frame while visible, with t in seconds." }),
			),
			label: Type.Optional(Type.String({ maxLength: 500, description: "Accessibility description." })),
		},
		{
			...strict,
			description:
				"2D drawing, as wide as the column. The host calls draw(id, width, height, t, pointer) for its commands; it redraws on resize and pointer moves, and every frame when animated.",
		},
	),
	Vector: Type.Object(
		{
			type: Type.Literal("vector"),
			key: Type.Optional(Key),
			width: Type.Number({ minimum: 1, maximum: 2000 }),
			height: Type.Number({ minimum: 1, maximum: 2000 }),
			label: Type.Optional(Type.String({ maxLength: 500, description: "Accessibility description." })),
			commands: Type.Integer({ minimum: 0, maximum: 20_000 }),
			ops: Type.Array(Type.Number(), { description: "Pen commands in DRAW_FORMAT (runtime.js)." }),
			strings: Type.Array(Type.String()),
		},
		{
			...strict,
			description:
				"A fixed-size drawing recorded while the view renders, in width x height units. Hosts draw it at that size, shrunk proportionally to fit a narrower parent.",
		},
	),
	Icon: Type.Object(
		{
			type: Type.Literal("icon"),
			key: Type.Optional(Key),
			name: Type.Enum([...VISUAL_ICONS]),
			size: Type.Optional(Type.Number({ minimum: 8, maximum: 128, description: "Points. Default 16." })),
			color: Type.Optional(Color),
		},
		{ ...strict, description: "A bundled Lucide icon. Default color: the inherited text color." },
	),
	Shader: Type.Object(
		{
			type: Type.Literal("shader"),
			key: Type.Optional(Key),
			height: Type.Number({ minimum: 24, maximum: 600, description: "Height in points. Default 240." }),
			animated: Type.Optional(
				Type.Boolean({ description: "Draw every display frame while visible. Default true; false draws once." }),
			),
			label: Type.Optional(Type.String({ maxLength: 500, description: "Accessibility description." })),
			glsl: Type.String({
				maxLength: 16 * 1024,
				description:
					"Shadertoy-style GLSL ES 3.00 defining mainImage. The revision carries its Metal translation, keyed by this text and the input names.",
			}),
			inputs: Type.Optional(
				Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,31}$" }), Type.Number(), {
					description: "Float uniforms by name, in name order, set from state on every view.",
				}),
			),
		},
		{ ...strict, description: "A fragment shader as wide as the column, drawn with Metal." },
	),
	Mermaid: Type.Object(
		{
			type: Type.Literal("mermaid"),
			key: Type.Optional(Key),
			source: Type.String({
				maxLength: 20 * 1024,
				description:
					"Bounded native flowchart/graph source. Check/publication rejects invalid syntax, unsupported grammar and limits; no browser fallback.",
			}),
		},
		{ ...strict, description: "A bounded native Mermaid flowchart with exact source inspection and expansion." },
	),
};

const Node = Type.Union(
	[
		nodes.Column,
		nodes.Row,
		nodes.Grid,
		nodes.Text,
		nodes.Stat,
		nodes.Table,
		nodes.Chart,
		nodes.Rule,
		nodes.Space,
		nodes.Link,
		nodes.Tabs,
		nodes.Toggle,
		nodes.Slider,
		nodes.Button,
		nodes.Canvas,
		nodes.Vector,
		nodes.Icon,
		nodes.Shader,
		nodes.Mermaid,
	],
	{ description: "One node, discriminated by type." },
);

export const VisualNodeSchema = Type.Cyclic({ Node }, "Node");

/** What the runtime returns for every view: the API version and the root node. */
export const VisualTreeSchema = Type.Cyclic(
	{
		Node,
		Tree: Type.Object({ api: Type.Literal(VISUAL_API_VERSION), root: Type.Ref("Node") }, strict),
	},
	"Tree",
);

export type VisualTree = Static<typeof VisualTreeSchema>;
export type VisualNode = Static<typeof VisualNodeSchema>;
export type VisualControl = Extract<VisualNode, { id: string }>;

/** The published JSON Schema document, with a stable identity and title. */
export function visualTreeJsonSchema(): Record<string, unknown> {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://pilot.dev/schemas/visual/api-1.json",
		title: "Pilot visual tree, API 1",
		...JSON.parse(JSON.stringify(VisualTreeSchema)),
	};
}
