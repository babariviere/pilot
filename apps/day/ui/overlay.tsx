// Overlays: what sits over a page instead of in its flow. A confirmation that asks before a strong action, a view
// that takes the whole window, a card that floats over a canvas, and the ring that names a control on the window.
// Each is drawn once, on the popover surface or the canvas, with the panel's hairline and radius.
import { type JSX, View } from "nsh";
import { Dialog } from "nsh/base";
import { GridBackdrop } from "./canvas";
import { narrow } from "./layout";
import { Caption, Title } from "./text";

/**
 * A confirmation over the page, before a strong action (interrupting a discussion): a title, one or two sentences
 * (`children`, a muted `Body`) and its `actions` (Cancel first, then the action, as `Button`s). The keyboard stays in
 * it; pressing outside or Escape closes it through `onClose` (pass `escape={false}` when the page's own Escape key
 * handles it). Rule: ask only before what cannot be taken back; say what stays.
 */
export function Confirm(props: {
	title: string;
	testID?: string;
	/** Cancel, then the action. */
	actions: JSX.Element;
	/** Whether Escape closes it (default true). */
	escape?: boolean;
	onClose: () => void;
	children?: JSX.Element;
}) {
	return (
		<Dialog
			accessibilityLabel={props.title}
			closeOnEscape={props.escape !== false}
			onOpenChange={(e) => {
				if (!e.open) props.onClose();
			}}
			class="absolute inset-0 items-center justify-center bg-background/90 p-6"
		>
			<View
				testID={props.testID}
				class="max-w-md gap-3 rounded-(--radius-panel) border border-border bg-popover px-4 py-3.5 shadow-lg"
			>
				<Title role="header">{props.title}</Title>
				{props.children}
				<View class="flex-row flex-wrap items-center gap-2 pt-0.5">{props.actions}</View>
			</View>
		</Dialog>
	);
}

/**
 * A view that takes the whole window over a page (the full chart, an artifact in the full window): the canvas with
 * its grid, a bar across the top (`bar`: a heading and a quiet line; `actions` at the right) with a hairline under
 * it, and the content filling the rest (`padded` keeps 16 points around it). It covers the page, which stays as it
 * was underneath. With `dialog`, the keyboard stays in it and nothing underneath takes presses (the artifact's).
 * Rule: one at a time; Escape and a Close or exit icon come back to where it opened.
 */
export function FullWindow(props: {
	bar: JSX.Element;
	actions?: JSX.Element;
	testID?: string;
	padded?: boolean;
	/** A modal dialog: its label for screen readers, and what runs once it shows (give its exit the focus). */
	dialog?: { label: string; testID?: string; onOpen?: () => void };
	children?: JSX.Element;
}) {
	const view = () => (
		<View testID={props.testID} class="absolute inset-0 bg-background">
			<GridBackdrop />
			<View
				class={`flex-row flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-background py-2.5 ${narrow() ? "px-3" : "px-6"}`}
			>
				<View class="min-w-0 flex-1 gap-0.5">{props.bar}</View>
				<View class="flex-row flex-wrap items-center gap-2">{props.actions}</View>
			</View>
			<View class={`min-h-0 flex-1 ${props.padded ? "p-4" : ""}`}>{props.children}</View>
		</View>
	);
	return (
		<If when={props.dialog} else={view()}>
			{(d) => (
				<Dialog
					testID={d().testID}
					accessibilityLabel={d().label}
					animation="fade"
					closeOnEscape={false}
					onOpen={() => d().onOpen?.()}
					class="absolute inset-0 bg-background"
				>
					{view()}
				</Dialog>
			)}
		</If>
	);
}

/** How a floating card is laid out inside. */
export type FloatingCardVariant = "card" | "hint" | "flush" | "surface";

/**
 * A card that floats over a page or a canvas: the popover surface, opaque, with the panel's radius, a hairline and
 * a shadow. `card` (default) pads its content and stacks it; `hint` is one short line (a pointing hint); `flush` has
 * no padding and clips, for content with sections of its own (the chart's field notes); `surface` is only the
 * opaque fill and shadow under a part that draws its own frame (a `Composer`). The page places it (an absolutely
 * placed `View` around it); `maxHeight` limits it. Rule: it floats only over a canvas or a page that stays visible.
 */
export function FloatingCard(props: {
	variant?: FloatingCardVariant;
	testID?: string;
	accessibilityLabel?: string;
	maxHeight?: number;
	children?: JSX.Element;
}) {
	const look = () => {
		const frame = "rounded-(--radius-panel) border border-border bg-popover shadow-lg";
		if (props.variant === "surface") return "rounded-(--radius-panel) bg-popover shadow-lg";
		if (props.variant === "hint") return `${frame} flex-row items-center gap-2 px-3 py-1.5`;
		if (props.variant === "flush") return `${frame} min-h-0 flex-1 overflow-hidden`;
		return `${frame} gap-3 px-4 py-3.5`;
	};
	return (
		<View
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			class={look()}
			style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}
		>
			{props.children}
		</View>
	);
}

/** Where a control sits on the window, in points. */
export type RingFrame = { x: number; y: number; width: number; height: number };

/**
 * A ring around a control on the window, with its name in a small accent tag: the control the person pointed at, or
 * the one the screen agent just used. It takes no presses. The tag goes under a control at the window's top edge,
 * where above would be cut off. Put it in an overlay that covers the window.
 */
export function Ring(props: { frame: RingFrame; label: string; testID?: string }) {
	return (
		<View
			testID={props.testID}
			class="absolute"
			style={{
				pointerEvents: "none",
				left: props.frame.x - 4,
				top: props.frame.y - 4,
				width: props.frame.width + 8,
				height: props.frame.height + 8,
			}}
		>
			<View class="absolute inset-0 rounded-lg border-2 border-ring bg-primary/10" />
			<View
				class={`absolute left-0 w-max rounded-md bg-primary px-1.5 py-0.5 ${props.frame.y < 28 ? "-bottom-6" : "-top-6"}`}
			>
				<Caption tone="onAccent">{props.label}</Caption>
			</View>
		</View>
	);
}
