// Invented records and scripted replies, test-only. No daemon or model.
import { mount, Scroll, signal } from "nsh";
import { KnowledgeSection, type LibraryCall } from "./settings/projects/KnowledgeSection";
import { restoreKnowledge, savedKnowledge } from "./settings/projects/knowledgeView";
import { Block, Button, Buttons, Caption, Column, Page, Panel } from "./ui";

const writes = signal(0);
const checks = signal(0);
const revision = signal(2);
const unknown = signal(false);
const pending = signal(false);
const mounted = signal(true);
const project = signal("p");
const hold = signal(false);
const losePreflight = signal(false);
let sent: Record<string, unknown> = {};
let committedRevision = 0;
const receipt = () => ({
	detail: { entry: { id: "k", projectId: "p" }, revision: { ...sent, revision: committedRevision } },
});
let release: (() => void) | undefined;
let saved = "";
const summary = () => ({
	id: "k",
	projectId: "p",
	kind: "investigation",
	title: "Storage facts",
	synopsis: "Observed storage behavior",
	revision: revision(),
	createdAt: 1,
	updatedAt: 2,
	origin: { recordedAt: 1 },
	freshness: { state: "needs_check" },
});
const source: LibraryCall = async (name, args) => {
	const r = args as Record<string, unknown>;
	if (name === "day.knowledge.save") {
		if (r.expectedRevision !== revision()) throw new Error(losePreflight() ? "lost" : "stale");
		sent = { ...r };
		writes.set(writes() + 1);
		if (hold())
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		pending.set(unknown());
		if (!unknown()) {
			revision.set(revision() + 1);
			committedRevision = revision();
		}
		return {
			operationId: "op",
			state: unknown() ? "unknown" : "saved",
			receipt: receipt(),
		};
	}
	if (name === "day.knowledge.check") {
		checks.set(checks() + 1);
		if (pending()) {
			revision.set(revision() + 1);
			committedRevision = revision();
		}
		pending.set(false);
		return {
			operationId: "op",
			state: "saved",
			receipt: receipt(),
		};
	}
	let data: unknown;
	if (r.kind === "list") data = { entries: r.query === "absent" ? [] : [summary()], more: false, cursor: null };
	if (r.kind === "pending")
		data =
			pending() || (r.id === "k" && r.expectedRevision === sent.expectedRevision && committedRevision > 0)
				? [{ operationId: "op", id: "k" }]
				: [];
	if (r.kind === "detail")
		data = {
			entry: summary(),
			revision: {
				knowledgeId: "k",
				revision: r.revision ?? revision(),
				title: "Storage facts",
				synopsis: "Observed storage behavior",
				body:
					r.revision === 1
						? "Historical finding"
						: "## Question\nStorage?\n## Findings\nObserved facts\n## Limitations\nNeeds a check",
				sources: [{ type: "repository", path: "src/store.ts", commit: "a".repeat(40) }],
				author: { type: "user" },
				recordedAt: 1,
				reason: "New evidence",
			},
			freshness: { state: "needs_check" },
		};
	if (r.kind === "revisions")
		data = {
			revisions: [{ revision: 1, title: "Storage facts", reason: "Original finding" }],
			more: false,
			cursor: null,
		};
	return { projectId: project(), data };
};

mount(() => (
	<Scroll class="flex-1">
		<Page width="form">
			<Block>
				<Caption tone="faint">Mock data</Caption>
				<Caption>{`Saves: ${writes()}. Checks: ${checks()}.`}</Caption>
				<Buttons>
					<Button label="Lose next reply" onPress={() => unknown.set(true)} />
					<Button label="Lose preflight reply" onPress={() => losePreflight.set(true)} />
					<Button label="Hold next save" onPress={() => hold.set(true)} />
					<Button
						label="Release reply"
						onPress={() => {
							release?.();
							release = undefined;
							hold.set(false);
						}}
					/>
					<Button label="New evidence" onPress={() => revision.set(revision() + 1)} />
					<Button
						label="Save window"
						onPress={() => {
							saved = savedKnowledge();
							mounted.set(false);
						}}
					/>
					<Button
						label="Restore window"
						onPress={() => {
							restoreKnowledge(saved);
							mounted.set(true);
						}}
					/>
					<Button label="Other project" onPress={() => project.set("other")} />
				</Buttons>
			</Block>
			<If when={mounted()}>
				<Panel>
					<Column>
						<KnowledgeSection projectId={project()} source={source} />
					</Column>
				</Panel>
			</If>
		</Page>
	</Scroll>
));
