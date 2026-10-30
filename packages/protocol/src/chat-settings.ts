/** Host-owned experimental chat behavior. Applies at the next eligible boundary. */
export interface ChatSettings {
	schemaVersion: 1;
	autoHandoff: boolean;
	revision: string;
}

export interface ChatSettingsPatch {
	autoHandoff: boolean;
	expectedRevision: string;
}
