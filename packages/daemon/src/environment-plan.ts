/** Install plan preview: what a host would need to match a profile. Pure; computing it changes nothing. */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type {
	EnvironmentHostRef,
	EnvironmentPlan,
	EnvironmentPlanItem,
	EnvironmentService,
	EnvironmentStep,
	EnvironmentTool,
	ProjectEnvironment,
} from "@pilot/protocol";
import { type EnvironmentProbes, postgresMajor } from "./environment-probes.ts";

const HOMEBREW_NETWORK = ["formulae.brew.sh", "ghcr.io"];

export interface PlanInput {
	projectId: string;
	host: EnvironmentHostRef;
	/** The effective profile: the shared layer with this host's override applied. */
	profile?: ProjectEnvironment;
	/** This host's override revision, 0 without one. */
	overrideRevision?: number;
	probes: EnvironmentProbes;
	/** Names in the host's mise registry, when it could be read. Backend references ("aqua:…") are never checked. */
	registry?: string[];
	/** Tools declared as go.mod tool directives, with their module version. */
	goTools: Record<string, string>;
	/** Review state per step ID and per "service:<id>": files that differ from the pin, [] when all match. */
	reviews: Record<string, string[]>;
	now: number;
}

function manual(
	subject: string,
	required: string,
	note: string,
	present?: EnvironmentPlanItem["present"],
): EnvironmentPlanItem {
	return {
		subject,
		required,
		...(present ? { present } : {}),
		action: "manual",
		commands: [],
		approval: "user-runs",
		impact: { network: [] },
		note,
	};
}

/** The mise executable the plan would use, after installing it with Homebrew when needed. */
function miseFor(probes: EnvironmentProbes): { path: string; viaHomebrew: boolean } | undefined {
	if (probes.installers.mise) return { path: probes.installers.mise, viaHomebrew: false };
	if (probes.installers.homebrew)
		return { path: join(dirname(probes.installers.homebrew), "mise"), viaHomebrew: true };
	return undefined;
}

function toolItem(tool: EnvironmentTool, input: PlanInput, mise: ReturnType<typeof miseFor>): EnvironmentPlanItem {
	const installed = input.probes.mise?.[tool.id] ?? [];
	const match = installed.find((entry) => entry.version === tool.version);
	const base = { subject: tool.id, required: tool.version };
	if (match)
		return {
			...base,
			present: { version: match.version, path: match.path },
			action: "none",
			installer: "mise",
			commands: [],
			approval: "plan",
			impact: { network: [] },
		};
	if (input.goTools[tool.id] === tool.version)
		return {
			...base,
			action: "none",
			installer: "go-tool",
			commands: [],
			approval: "plan",
			impact: { network: [] },
			note: `Provided by go tool at the go.mod version. Run it as go tool ${tool.id}.`,
		};
	if (input.registry && !tool.id.includes(":") && !input.registry.includes(tool.id))
		return manual(
			tool.id,
			tool.version,
			`mise doesn't know ${tool.id}. Use a name from mise's registry or a backend such as aqua:owner/repo.`,
		);
	const other = installed.at(-1);
	const present = other ? { version: other.version, path: other.path } : undefined;
	if (mise)
		return {
			...base,
			...(present ? { present } : {}),
			action: "install",
			installer: "mise",
			commands: [[mise.path, "install", `${tool.id}@${tool.version}`]],
			approval: "plan",
			// mise knows where each tool downloads from; Pilot does not guess hosts or sizes.
			impact: { network: [] },
			note: present
				? `mise has ${present.version}; it stays installed.`
				: "mise downloads it from the tool's own release source.",
		};
	return manual(
		tool.id,
		tool.version,
		"Install mise (mise.jdx.dev) or Homebrew on this host, then check again.",
		present,
	);
}

function postgresPackage(system: NonNullable<EnvironmentProbes["installers"]["system"]>, major: string): string[] {
	return system === "apt-get"
		? ["sudo", "apt-get", "install", "-y", `postgresql-${major}`]
		: ["sudo", system, "install", "-y", `postgresql${major}-server`];
}

function serviceItem(service: EnvironmentService, input: PlanInput): EnvironmentPlanItem {
	const subject = service.id;
	const required = service.version;
	if (service.provider === "compose") {
		const compose = service.compose!;
		const changed = input.reviews[`service:${service.id}`];
		if (!compose.review || changed?.length)
			return {
				subject,
				required,
				action: "review",
				installer: "compose",
				commands: [],
				approval: "plan",
				impact: { network: [] },
				note: compose.review
					? `${changed!.join(", ")} changed since review. Review it before Pilot starts it.`
					: `Review ${compose.file} before Pilot starts it.`,
			};
		const docker = input.probes.installers.docker;
		if (!docker)
			return manual(
				subject,
				required,
				"Install Docker on this host to use the compose service, or use the built-in database.",
			);
		return {
			subject,
			required,
			action: "start",
			installer: "compose",
			commands: [
				[docker, "compose", "-p", `pilot-${input.projectId}`, "-f", compose.file, "up", "-d", compose.service],
			],
			approval: "plan",
			impact: { network: ["docker.io"] },
		};
	}
	const match = input.probes.postgres[service.version]?.find(
		(result) => result.version && postgresMajor(result.version) === service.version,
	);
	if (match)
		return {
			subject,
			required,
			present: { version: match.version!, path: match.path },
			action: "start",
			installer: "pilot",
			commands: [],
			approval: "plan",
			impact: { network: [] },
			note: `Start Pilot's Postgres ${service.version} server if it isn't running. Each chat workspace gets its own database.`,
		};
	const { homebrew, docker, system } = input.probes.installers;
	if (homebrew)
		return {
			subject,
			required,
			action: "install",
			installer: "homebrew",
			commands: [[homebrew, "install", `postgresql@${service.version}`]],
			approval: "plan",
			impact: { network: HOMEBREW_NETWORK },
			note: `Then Pilot starts its own Postgres ${service.version} server, with a database for each chat workspace.`,
		};
	// Without Homebrew or system Postgres, Pilot runs one long-lived container per host (named volume, loopback port).
	if (docker)
		return {
			subject,
			required,
			action: "start",
			installer: "docker",
			commands: [],
			approval: "plan",
			impact: { network: ["docker.io"] },
			note: `Start Pilot's Postgres ${service.version} container (postgres:${service.version}, data in a named volume, reachable on loopback only), with a database for each chat workspace.`,
		};
	return {
		subject,
		required,
		action: "manual",
		...(system ? { installer: "system" as const } : {}),
		commands: system ? [postgresPackage(system, service.version)] : [],
		approval: "user-runs",
		impact: { network: [] },
		note: system
			? "Install Homebrew or Docker, or run this in a terminal on this host, then check again. Pilot never runs sudo."
			: "Install Homebrew or Docker on this host, then check again.",
	};
}

function stepCommand(step: EnvironmentStep): string[] {
	return "argv" in step.run ? step.run.argv : [step.run.script, ...(step.run.args ?? [])];
}

function stepItem(step: EnvironmentStep, input: PlanInput): EnvironmentPlanItem {
	const changed = input.reviews[step.id];
	const base = { subject: `step:${step.id}`, required: step.title };
	if (!step.review || changed?.length)
		return {
			...base,
			action: "review",
			commands: [stepCommand(step)],
			approval: "plan",
			impact: { network: [] },
			note: step.review
				? `${changed!.join(", ")} changed since review. Review it to run setup.`
				: "Review the files this step runs before setup can run it.",
		};
	return {
		...base,
		action: "run",
		commands: [stepCommand(step)],
		approval: "plan",
		impact: { network: [] },
		note: "Runs in each new or restored workspace.",
	};
}

/** Hash of everything the preview showed. Apply recomputes the plan and refuses a different hash. */
export function planHash(
	input: Pick<EnvironmentPlan, "host" | "projectId" | "profileRevision" | "overrideRevision" | "items">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				daemonId: input.host.daemonId,
				projectId: input.projectId,
				profileRevision: input.profileRevision,
				overrideRevision: input.overrideRevision,
				items: input.items,
			}),
		)
		.digest("hex");
}

export function computeEnvironmentPlan(input: PlanInput): EnvironmentPlan {
	const profile = input.profile;
	const items: EnvironmentPlanItem[] = [];
	if (profile) {
		const mise = miseFor(input.probes);
		const tools = profile.tools.map((tool) => toolItem(tool, input, mise));
		if (mise?.viaHomebrew && tools.some((item) => item.installer === "mise" && item.action === "install"))
			items.push({
				subject: "mise",
				required: "any",
				action: "install",
				installer: "homebrew",
				commands: [[input.probes.installers.homebrew!, "install", "mise"]],
				approval: "plan",
				impact: { network: HOMEBREW_NETWORK },
				note: "mise is missing; Homebrew installs it first.",
			});
		items.push(...tools, ...profile.services.map((service) => serviceItem(service, input)));
		items.push(...profile.steps.map((step) => stepItem(step, input)));
	}
	const plan = {
		host: input.host,
		projectId: input.projectId,
		profileRevision: profile?.revision ?? 0,
		overrideRevision: input.overrideRevision ?? 0,
		items,
	};
	return { ...plan, planHash: planHash(plan), computedAt: input.now };
}
