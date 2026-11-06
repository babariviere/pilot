/** Host-owned automation admission. Legacy autoHandoff is not an API setting. */
export interface ChatSettings {
	schemaVersion: 1;
	/** Host-wide automation admission. Off until explicitly enabled. */
	automations: boolean;
	revision: string;
}

export interface ChatSettingsPatch {
	automations?: boolean;
	expectedRevision: string;
}
