/** Daemon-owned energy policy. Closed-lid overrides are macOS-only. No network names. */
export interface PowerSettings {
	keepAwake: boolean;
	closedLid: boolean;
}
export interface PowerStatus {
	settings: PowerSettings;
	available: boolean;
	authorized: boolean;
	keepingAwake: boolean;
	closedLidActive: boolean;
	paused: boolean;
	connectedToPower: boolean;
	wifiConnected: boolean;
	error?: string;
}
