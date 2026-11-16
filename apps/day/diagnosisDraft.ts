// Unsent diagnostics inputs. Restore never starts work or changes consent.
import { signal } from "nsh";
export type PrivacyDraft = {
	binding: string;
	localDiagnostics: boolean;
	localFeatureUsage: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	endpoint: string;
};
export const privacyDraft = signal<PrivacyDraft | null>(null);
export const diagnosisQuestion = signal("");
export const diagnosisModel = signal("");
export const diagnosisThinking = signal("");
export const diagnosisReplies = signal<Record<string, string>>({});
export function safeCollector(s: string): boolean {
	return (
		s.length <= 512 &&
		/^(?:https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?|http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?)(?:\/|\/v1\/traces)?$/.test(
			s,
		)
	);
}
export function savedDiagnosis(): string {
	const p = privacyDraft();
	return JSON.stringify({
		privacy: p ? { ...p, endpoint: safeCollector(p.endpoint) ? p.endpoint : "" } : null,
		question: diagnosisQuestion(),
		model: diagnosisModel(),
		thinking: diagnosisThinking(),
		replies: diagnosisReplies(),
	});
}
export function restoreDiagnosis(text: string) {
	privacyDraft.set(null);
	diagnosisQuestion.set("");
	diagnosisModel.set("");
	diagnosisThinking.set("");
	diagnosisReplies.set({});
	if (!text) return;
	try {
		const d = JSON.parse(text);
		if (typeof d.question === "string") diagnosisQuestion.set(d.question);
		if (typeof d.model === "string") diagnosisModel.set(d.model);
		if (typeof d.thinking === "string") diagnosisThinking.set(d.thinking);
		if (d.replies && typeof d.replies === "object" && Object.values(d.replies).every((v) => typeof v === "string"))
			diagnosisReplies.set(d.replies);
		const p = d.privacy;
		if (
			p &&
			typeof p.binding === "string" &&
			typeof p.endpoint === "string" &&
			(!p.endpoint || safeCollector(p.endpoint)) &&
			[p.localDiagnostics, p.localFeatureUsage, p.remoteOperational, p.productAnalytics].every(
				(v) => typeof v === "boolean",
			)
		)
			privacyDraft.set(p);
	} catch {
		/* Invalid drafts never submit. */
	}
}
