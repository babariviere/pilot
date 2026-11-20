// Atmosphere: the dithered sky of a quiet place, and the faint grid of the canvas behind the panel. Both are drawn
// once for each size and appearance (a `Canvas` runs its drawing again only when it resizes or a token it reads
// changes); nothing here animates or runs per frame.
import { Canvas, type CanvasRenderingContext2D, type JSX, Path2D, token, View } from "nsh";
import { Caption, Title } from "./text";

/** The 8 by 8 ordered (Bayer) threshold matrix: hard square pixels, no smooth gradients. */
const BAYER = [
	0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
	54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
	61, 29, 53, 21,
];

/** One dither pixel, in points. */
const CELL = 3;

/**
 * Draws a late-afternoon sky in ordered dither: bands of cloud that thin out downward in the accent, and a low sun
 * on the right in amber, at 60% so words over it stay readable (round-4's Quiet).
 */
function drawSky(cx: CanvasRenderingContext2D, width: number, height: number) {
	const w = Math.ceil(width / CELL);
	const h = Math.ceil(height / CELL);
	if (w === 0 || h === 0) return;
	const ink = new Path2D();
	const sun = new Path2D();
	for (let j = 0; j < h; j++) {
		for (let i = 0; i < w; i++) {
			const u = i / w;
			const v = j / h;
			const b = (BAYER[(j & 7) * 8 + (i & 7)] + 0.5) / 64;
			const cloud = 0.5 + 0.3 * Math.sin(u * 9 + v * 4) + 0.2 * Math.sin(u * 23 - v * 11 + 1.3);
			const t = (1 - v) ** 1.7 * (0.1 + 0.5 * cloud) * (0.4 + 0.6 * u);
			const dx = (u - 0.84) * (w / h);
			const dy = v - 0.32;
			const g = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 0.46);
			if (g * g * 0.8 * (1 - v) ** 0.5 > b) sun.rect(i * CELL, j * CELL, CELL, CELL);
			else if (t > b) ink.rect(i * CELL, j * CELL, CELL, CELL);
		}
	}
	cx.globalAlpha = 0.6;
	cx.fillStyle = token("progress");
	cx.fill(ink);
	cx.fillStyle = token("needs");
	cx.fill(sun);
}

/**
 * The quiet place: when nothing needs the user, the section says so in one line under Pilot's dithered sky. It is
 * the only decoration in the app. 300 points high (`height` to change it), filling its section's width.
 */
export function Quiet(props: { title: string; text?: string; height?: number; testID?: string }) {
	return (
		<View testID={props.testID} class="relative overflow-hidden" style={{ height: props.height ?? 300 }}>
			<Canvas
				class="absolute inset-0"
				accessible={false}
				draw={(cx, size) => drawSky(cx, size.width, size.height)}
			/>
			<View class="absolute bottom-4 left-4 right-4 gap-0.5">
				<Title>{props.title}</Title>
				<If when={props.text}>
					<Caption>{props.text ?? ""}</Caption>
				</If>
			</View>
		</View>
	);
}

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
