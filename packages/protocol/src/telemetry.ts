/** Effective settings for one daemon host. Export and analytics are explicit, independent opt-ins. */
export interface TelemetrySettings {
	schemaVersion: 1;
	hostKind: "local" | "devbox";
	/** Pseudonymous host correlation. This is never a raw HostRef field. */
	hostId: string;
	localDiagnostics: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	/** Local app/daemon analytics identity. Present only on the local host while analytics consent is on. */
	analyticsId?: string;
	/** Present only after validation. Never contains userinfo, a query, fragment or credential. */
	endpoint?: string;
	updatedAt?: string;
}

export interface TelemetrySettingsPatch {
	localDiagnostics: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	endpoint?: string;
}

export interface TelemetryClearResponse {
	cleared: true;
}
