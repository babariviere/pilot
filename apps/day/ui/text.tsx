// Text roles. A screen picks a role for each piece of words and never sets a size, a weight or a family: the
// role does. Sizes follow the compact Forge scale (round-4 mockup, "Size and shape"): display 22/650, title
// 16/600, heading 13/600, body 13/18, caption 11.5, numbers 11 in Geist Mono. Colour comes from a tone.
import { type JSX, Text, type TextStyle } from "nsh";

/**
 * A text colour, by meaning. `default` is the main text; `muted` meta and help; `faint` times, counts and quiet
 * notes; `needs`, `failed` and `ok` only for those states' words; `accent` only for a link's words.
 */
export type Tone = "default" | "muted" | "faint" | "needs" | "failed" | "ok" | "accent" | "onAccent";

/** The token class of each tone. Library parts use it; screens pass `tone`. */
export const TONE: Record<Tone, string> = {
	default: "text-foreground",
	muted: "text-muted-foreground",
	faint: "text-faint",
	needs: "text-needs-ink",
	failed: "text-failed-ink",
	ok: "text-ok-ink",
	accent: "text-primary",
	onAccent: "text-primary-foreground",
};

/**
 * The type scale, in points, in one place. Library parts read it; a screen never does. Literal sizes live only
 * here because the scale has steps (11.5, 22) that Tailwind's text classes do not have.
 */
export const TYPE = {
	display: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.6 },
	title: { fontSize: 16, lineHeight: 21, fontWeight: "600", letterSpacing: -0.16 },
	heading: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
	body: { fontSize: 13, lineHeight: 18 },
	bodyStrong: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
	control: { fontSize: 13, lineHeight: 16, fontWeight: "500" },
	caption: { fontSize: 11.5, lineHeight: 17 },
	captionStrong: { fontSize: 11.5, lineHeight: 17, fontWeight: "500" },
	number: { fontSize: 11, lineHeight: 16 },
} satisfies Record<string, TextStyle>;

/** What every role takes besides its words. Layout only: no size, weight, family or colour class. */
export type TextRoleProps = {
	children?: JSX.Element;
	/** The colour, by meaning (each role has its own default). */
	tone?: Tone;
	testID?: string;
	/** `header` for a heading screen readers jump to; `alert` for words they say as soon as they show. */
	role?: "header" | "alert";
	accessibilityLabel?: string;
	/** One line, cut off with an ellipsis when it does not fit. */
	truncate?: boolean;
	/** Takes the rest of its row and may shrink, so long words wrap or cut off inside it. */
	grow?: boolean;
	/** Keeps a comfortable reading width (about 64 characters). Body only. */
	measure?: boolean;
};

function role(style: TextStyle, tone: Tone, family = "") {
	return (props: TextRoleProps) => (
		<Text
			testID={props.testID}
			role={props.role}
			accessibilityLabel={props.accessibilityLabel}
			class={`${family} ${TONE[props.tone ?? tone]}`}
			classList={{
				truncate: props.truncate === true,
				"min-w-0 flex-1": props.grow === true,
				"max-w-lg": props.measure === true,
			}}
			style={style}
		>
			{props.children}
		</Text>
	);
}

/** The page's one headline (its title). One per page, in the PageHead. */
export const Display = role(TYPE.display, "default");
/** The thing that asks: a Question's title, the Quiet sky's line. */
export const Title = role(TYPE.title, "default");
/** A section's name. Use it through `Section`; on its own only in a part that has no section. */
export const Heading = role(TYPE.heading, "default");
/** Rows' titles and sentences: the words that carry the work. */
export const Body = role(TYPE.body, "default");
/** A row title or an option's words: body size, one step heavier. */
export const BodyStrong = role(TYPE.bodyStrong, "default");
/** Meta and help: a row's second line, a field's help, a notice's detail. */
export const Caption = role(TYPE.caption, "muted");
/**
 * The Number role: times, counts, ids and progress counts, in Geist Mono. Use it for every number that is not in a
 * sentence. Exported as `Num` so it does not hide JavaScript's `Number`.
 */
export const Num = role(TYPE.number, "faint", "font-mono");
