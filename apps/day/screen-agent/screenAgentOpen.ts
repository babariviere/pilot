// Whether the window's screen agent bar shows, and whether this window has one. Its own module, so the palette
// and header can open it without importing the bar.
import { signal } from "nsh";

/** The bar shows. Command+J and the palette set it; Esc clears it. */
export const screenAgentOpen = signal(false);

/** This window has a screen agent: only a connected window does. */
export const screenAgentAvailable = signal(false);
