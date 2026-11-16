// Unsaved model configuration only. Never add sign-in challenges, answers or credentials here.
import { signal } from "nsh";
import type { ModelDefaults } from "./modelControls";

export const modelEdit = signal<"defaults" | "scope" | null>(null);
export const modelDraft = signal<ModelDefaults | null>(null);
export const modelPatterns = signal<string[]>([]);
export const modelReplacement = signal("");
export const modelEditBinding = signal("");
export const modelEditProject = signal("");

export function savedModelDraft(): string {
	return modelEdit()
		? JSON.stringify({
				kind: modelEdit(),
				defaults: modelDraft(),
				patterns: modelPatterns(),
				replacement: modelReplacement(),
				binding: modelEditBinding(),
				project: modelEditProject(),
			})
		: "";
}
export function restoreModelDraft(text: string) {
	modelEdit.set(null);
	if (!text) return;
	try {
		const d = JSON.parse(text);
		if (
			!["defaults", "scope"].includes(d.kind) ||
			typeof d.binding !== "string" ||
			typeof d.project !== "string" ||
			!Array.isArray(d.patterns) ||
			d.patterns.some((p: unknown) => typeof p !== "string") ||
			(d.kind === "defaults" && (!d.defaults || typeof d.defaults !== "object")) ||
			typeof d.replacement !== "string"
		)
			return;
		modelDraft.set(d.defaults);
		modelPatterns.set(d.patterns);
		modelReplacement.set(d.replacement);
		modelEditBinding.set(d.binding);
		modelEditProject.set(d.project);
		modelEdit.set(d.kind);
	} catch {
		/* Invalid saved drafts are not submitted. */
	}
}
