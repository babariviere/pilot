/** Daemon-owned Mac energy policy. No network names or Location Services. */
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
