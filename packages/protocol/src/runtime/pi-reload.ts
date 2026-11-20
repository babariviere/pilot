/** App-wide pi configuration reload. Counts refer only to workers live at admission. */
export interface PiReloadStatus {
	operationId: string | null;
	pending: number;
	reloading: number;
	reloaded: number;
	failed: number;
}
