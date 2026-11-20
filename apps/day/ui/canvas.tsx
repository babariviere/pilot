// The window's faint grid.
import { Canvas, type JSX, Path2D, token, View } from "nsh";

/** The grid's spacing, in points. */
const GRID = 32;

/**
 * The canvas behind a window's pages: a faint 32-point grid on the background colour. Put it first in the window's
 * root, which must not be transparent; it takes no presses and screen readers skip it. `WindowCanvas` does both.
 */
export function GridBackdrop() {
	return (
		<Canvas
			class="absolute inset-0"
			accessible={false}
			draw={(cx, size) => {
				const lines = new Path2D();
				for (let x = 0; x < size.width; x += GRID) lines.rect(x, 0, 1, size.height);
				for (let y = 0; y < size.height; y += GRID) lines.rect(0, y, size.width, 1);
				cx.fillStyle = token("grid");
				cx.fill(lines);
			}}
		/>
	);
}

/**
 * A window's root: the background colour with the canvas grid behind its children. Every window and every test
 * entry that mounts a screen or a part without Day's own window root starts with it, so pages sit on the same
 * canvas everywhere.
 */
export function WindowCanvas(props: { testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}
