// Presentation mirror only. Rust selects the profile and journals every effect.
import { signal } from "nsh";
import { call, windowId } from "./bridge";

export type SourcePreview = { path: string; copy: "jj" | "folder"; digest: string };
export type ImportPreview = { destination: string; resolvedDestination: string };
export type Import = { id: string; url: string; destination: string; phase: string; problem?: string };
export type ProjectSetup = {
	version: number;
	projects: {
		id: string;
		name: string;
		path: string;
		copy: string;
		setup: { id: string; name: string; enabled: boolean }[];
	}[];
	github: {
		phase: string;
		apiReady: boolean;
		sshReady: boolean;
		sshIdentity?: string;
		account?: string;
		fingerprint?: string;
		challenge?: { url: string; code: string };
		problem?: string;
	};
	imports: Import[];
};
type Operation = { operationId: string; state: string; receipt?: { reason?: string } };
export type ProjectsReply = { snapshot: ProjectSetup | null; operations?: Operation[]; outcome?: Operation | null };
export interface ProjectsSource {
	read(): Promise<ProjectsReply>;
	preview(args: { path: string } | { url: string; destination?: string }): Promise<SourcePreview | ImportPreview>;
	action(args: Record<string, string>): Promise<ProjectsReply>;
	check(operationId: string): Promise<ProjectsReply>;
}
async function invoke<T>(name: string, args: unknown): Promise<T> {
	const window = windowId();
	if (!window) throw new Error("Project setup needs a connected native window.");
	const r = await call<unknown>(window, name, args);
	if (!r.ok)
		throw new Error(
			r.refusal === "unknown" || r.refusal === "lost"
				? "The result is unknown. Read again, then Check. Nothing will be sent again."
				: "Project setup is unavailable. Read again before continuing.",
		);
	return r.value as T;
}
export const nativeProjects: ProjectsSource = {
	read: () => invoke("day.projects.setup", {}),
	preview: async (args) =>
		(await invoke<{ snapshot: SourcePreview | ImportPreview }>("day.projects.preview", args)).snapshot,
	action: (args) => invoke("day.projects.action", args),
	check: (operationId) => invoke("day.projects.check", { operationId }),
};
export const projectFolder = signal("");
export const projectRepository = signal("");
export const projectDestination = signal("");
export function savedProjectSetup(): string[] {
	return [projectFolder(), projectRepository(), projectDestination()];
}
export function restoreProjectSetup(v: string[]): void {
	projectFolder.set(v[0] ?? "");
	projectRepository.set(v[1] ?? "");
	projectDestination.set(v[2] ?? "");
}
