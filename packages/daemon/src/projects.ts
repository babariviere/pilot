/** Projects: named working directories that sessions (and later, triggers) belong to. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Project, ProjectRequest } from "@pilot/protocol";
import { NotFound } from "./errors.ts";

export function expandHome(path: string): string {
	return resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

export async function requireDirectory(path: string): Promise<string> {
	const resolved = expandHome(path);
	if (!(await stat(resolved).catch(() => undefined))?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	return resolved;
}

export class ProjectStore {
	private projects: Project[] = [];
	private readonly listeners = new Set<(projects: Project[]) => void>();
	private saving: Promise<void> = Promise.resolve();

	constructor(private readonly home: string) {}

	private get file(): string {
		return join(this.home, "projects.json");
	}

	async load(): Promise<void> {
		await mkdir(this.home, { recursive: true, mode: 0o700 });
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Project[];
			this.projects = Array.isArray(parsed) ? parsed : [];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	onChange(listener: (projects: Project[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): Project[] {
		return [...this.projects].sort((a, b) => a.name.localeCompare(b.name));
	}

	get(id: string): Project | undefined {
		return this.projects.find((project) => project.id === id);
	}

	require(id: string): Project {
		const project = this.get(id);
		if (!project) throw new NotFound(`Unknown project: ${id}`);
		return project;
	}

	async create(request: ProjectRequest): Promise<Project> {
		if (typeof request.path !== "string" || !request.path.trim()) throw new Error("path is required");
		const path = await requireDirectory(request.path);
		if (this.projects.some((project) => project.path === path)) throw new Error(`A project already uses ${path}`);
		const project: Project = {
			id: randomUUID(),
			name: request.name?.trim() || basename(path),
			path,
			createdAt: Date.now(),
			...(request.model?.trim() ? { model: request.model.trim() } : {}),
		};
		this.projects.push(project);
		await this.persist();
		return project;
	}

	async update(id: string, request: Partial<ProjectRequest>): Promise<Project> {
		const project = this.require(id);
		const next: Project = { ...project };
		if (request.name !== undefined) {
			if (!request.name.trim()) throw new Error("name cannot be empty");
			next.name = request.name.trim();
		}
		if (request.path !== undefined) next.path = await requireDirectory(request.path);
		if (request.model !== undefined) {
			if (request.model?.trim()) next.model = request.model.trim();
			else delete next.model;
		}
		this.projects = this.projects.map((existing) => (existing.id === id ? next : existing));
		await this.persist();
		return next;
	}

	/** Sessions keep their projectId; clients show them as unassigned. */
	async remove(id: string): Promise<void> {
		this.require(id);
		this.projects = this.projects.filter((project) => project.id !== id);
		await this.persist();
	}

	private persist(): Promise<void> {
		const snapshot = `${JSON.stringify(this.projects, null, "\t")}\n`;
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				const temp = `${this.file}.${randomUUID()}.tmp`;
				await writeFile(temp, snapshot, { mode: 0o600 });
				await rename(temp, this.file);
			});
		const projects = this.list();
		for (const listener of this.listeners) listener(projects);
		return this.saving;
	}
}
