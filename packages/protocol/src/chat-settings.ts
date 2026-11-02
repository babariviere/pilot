/** Host-owned experimental chat behavior. Applies at the next eligible boundary. */
export interface ChatSettings {
	schemaVersion: 1;
	autoHandoff: boolean;
	/** Host-wide automation admission. Off until explicitly enabled. */
	automations: boolean;
	revision: string;
}

export interface ChatSettingsPatch {
	autoHandoff?: boolean;
	automations?: boolean;
	expectedRevision: string;
}
