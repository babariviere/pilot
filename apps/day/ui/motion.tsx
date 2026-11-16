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

/** Its children arrive once, when it mounts. Key it by what arrived (a screen, a question) so it plays again for the next one. */
export function Arrive(props: { children?: JSX.Element; class?: string; testID?: string }) {
	const m = createMotion({ enter: ARRIVE });
	return (
		<View testID={props.testID} class={props.class} style={m.style}>
			{props.children}
		</View>
	);
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
