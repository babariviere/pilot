// The app's one motion treatment: restrained, short and never a claim.
// A screen or a new interview step arrives with a short fade and a small
// rise; panels that open or close glide to their new size. Motion only
// follows what Rust already published: it never stands for a send, a
// save or an answer, and it never delays a control. Motions follow the
// user's reduced-motion setting on their own; layout glides are skipped.
import { createMotion, type JSX, LayoutAnimation, type MotionSpec, reduceMotion, View } from "nsh";

/** How long arriving and gliding take, in milliseconds. */
export const MOTION_MS = 180;

/** A short fade with a 6-point rise, easing out. */
const ARRIVE: MotionSpec = {
	duration: MOTION_MS,
	keyframes: { opacity: [0, 1], translateY: [{ value: 6, easing: "easeOut" }, 0] },
};

/** A short fade alone, for content that replaces content in the same place. */
const FADE_IN: MotionSpec = { duration: MOTION_MS, keyframes: { opacity: [{ value: 0, easing: "easeOut" }, 1] } };

/** How long leaving takes: a little quicker than arriving, so closing never feels slow. */
export const LEAVE_MS = 140;

/** A fade with a 4-point lift, easing in: the way out of what Arrive brought in. */
const LEAVE: MotionSpec = {
	duration: LEAVE_MS,
	keyframes: { opacity: [{ value: 1, easing: "easeIn" }, 0], translateY: [{ value: 0, easing: "easeIn" }, -4] },
};

/** Its children arrive once, when it mounts. Key it by what arrived (a screen, a question) so it plays again for the next one. */
export function Arrive(props: { children?: JSX.Element; class?: string; testID?: string }) {
	const m = createMotion({ enter: ARRIVE });
	return (
		<View testID={props.testID} class={props.class} style={m.style}>
			{props.children}
		</View>
	);
}

/** Its children fade in once, in place, when it mounts. Key it by what replaced the content before (a tab, a side). */
export function FadeIn(props: { children?: JSX.Element; class?: string; testID?: string }) {
	const m = createMotion({ enter: FADE_IN });
	return (
		<View testID={props.testID} class={props.class} style={m.style}>
			{props.children}
		</View>
	);
}

/**
 * A panel that arrives when it mounts and can leave before it unmounts: bind `style`, then await `leave()` before
 * removing it with `glide()`, so the panel fades out first and the content below then closes the gap.
 */
export function createPanelMotion(): { style: object; leave(): Promise<void>; arrive(): void } {
	const m = createMotion({ enter: ARRIVE });
	return {
		style: m.style,
		leave: async () => {
			if (reduceMotion()) return;
			await m.play(LEAVE);
		},
		// Brings it back when it is opened again while it leaves.
		arrive: () => void m.play(ARRIVE),
	};
}

/** Lets the next update's size and position changes glide: call it right before opening or closing a panel. */
export function glide() {
	if (reduceMotion()) return;
	LayoutAnimation.configureNext({
		duration: MOTION_MS,
		create: { type: "easeOut", property: "opacity" },
		update: { type: "easeInEaseOut" },
		delete: { type: "easeIn", property: "opacity" },
	});
}
