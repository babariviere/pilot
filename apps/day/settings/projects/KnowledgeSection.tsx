// A paged library inside Settings' Project tab. One page at a time limits kept rows;
// selecting or reading sources never starts AI work or accepts guidance.
import { cleanup, effect, host, signal, untracked, View } from "nsh";
import type {
	KnowledgeDetail,
	KnowledgePage,
	KnowledgeRevisionPage,
} from "../../../../packages/protocol/src/knowledge/knowledge";
import { call, windowId } from "../../sources/bridge";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	EmptyLine,
	Field,
	Heading,
	Link,
	Notice,
	Row,
	RowDetail,
	Rows,
	Section,
	TextField,
} from "../../ui";
import { editKnowledge, type KnowledgeEdit, knowledgeDraft, knowledgeFingerprint, libraryOpen } from "./knowledgeView";

export type LibraryCall = (name: string, args: unknown) => Promise<unknown>;
const nativeCall: LibraryCall = async (name, args) => {
	const window = windowId();
	if (!window) throw new Error("unavailable");
	const r = await call<unknown>(window, name, args);
	if (!r.ok) throw new Error(r.refusal);
	return r.snapshot;
};
type ReadResult<T> = { projectId: string; data: T };
type Saved = { operationId: string; state: "saved" | "rejected" | "unknown"; receipt?: { detail?: KnowledgeDetail } };
/** Sources, revisions and unsent edits for the selected project. */
export function KnowledgeSection(props: { projectId: string; source?: LibraryCall }) {
	const query = signal("");
	const page = signal<KnowledgePage | null>(null);
	const detail = signal<KnowledgeDetail | null>(null);
	const revisions = signal<KnowledgeRevisionPage | null>(null);
	const pending = signal<{ operationId: string; id: string }[]>([]);
	const operationsKnown = signal(false);
	const busy = signal(false);
	const stale = signal(false);
	const message = signal("");
	let generation = 0;
	let readProject = "";
	effect(() => {
		const project = props.projectId;
		untracked(() => {
			generation++;
			readProject = project;
			page.set(null);
			detail.set(null);
			revisions.set(null);
			pending.set([]);
			operationsKnown.set(false);
			busy.set(false);
			message.set("");
			stale.set(false);
		});
	});
	const send = (name: string, args: unknown) => (props.source ?? nativeCall)(name, args);
	const draft = () => knowledgeDraft();
	const localDraft = () => (draft()?.projectId === props.projectId ? draft() : null);
	const shown = () => (readProject === props.projectId ? detail() : null);
	const change = (key: keyof Pick<KnowledgeEdit, "title" | "synopsis" | "body" | "reason">, value: string) => {
		const d = localDraft();
		if (d) knowledgeDraft.set({ ...d, [key]: value, editVersion: (d.editVersion ?? 0) + 1 });
	};
	// A notice only ages displayed understanding. It performs no service read or write.
	const stop = props.source ? () => {} : host.on("day.changed", () => stale.set(true));
	cleanup(() => {
		generation++;
		stop();
	});
	const run = async (f: () => Promise<void>) => {
		if (busy()) return;
		const token = generation;
		busy.set(true);
		message.set("");
		try {
			await f();
		} catch (error) {
			if (token !== generation) return;
			stale.set(true);
			message.set(
				error instanceof Error && error.message === "capacity"
					? "Pilot's local command journal reached its shared capacity. Your draft stays unsaved. Do not delete the journal to retry."
					: "Could not read or confirm this change. Your draft stays. Read again or Check the saved operation; nothing is resent.",
			);
		} finally {
			if (token === generation) busy.set(false);
		}
	};
	const read = async <T,>(request: unknown): Promise<T> => {
		const token = generation;
		const project = props.projectId;
		const r = (await send("day.knowledge.read", request)) as ReadResult<T>;
		if (token !== generation || project !== props.projectId || r.projectId !== project) throw new Error("stale");
		readProject = project;
		return r.data;
	};
	const search = (cursor: string | null = null) =>
		run(async () => {
			const data = await read<KnowledgePage>({ kind: "list", query: query(), cursor, missionId: null });
			page.set(data);
			stale.set(false);
			await readOperations();
		});
	const open = (id: string, revision: number | null = null) =>
		run(async () => {
			detail.set(await read<KnowledgeDetail>({ kind: "detail", id, revision }));
			revisions.set(null);
			stale.set(false);
		});
	const history = (cursor: string | null = null) =>
		run(async () => {
			const d = shown();
			if (d) revisions.set(await read({ kind: "revisions", id: d.entry.id, cursor }));
		});
	const settle = (r: Saved) => {
		if (r.state === "saved") {
			const committed = r.receipt?.detail;
			const d = localDraft();
			if (
				committed &&
				d &&
				committed.entry.id === d.id &&
				committed.entry.projectId === d.projectId &&
				committed.revision.revision === d.expectedRevision + 1
			) {
				const stored = {
					...editKnowledge(committed),
					expectedRevision: committed.revision.revision - 1,
					reason: committed.revision.reason ?? "",
				};
				if (d.submittedHash !== knowledgeFingerprint(stored)) {
					knowledgeDraft.set({ ...d, submittedVersion: undefined, submittedHash: undefined });
					message.set(
						"This receipt saved earlier words, not this draft. Your words stay unsaved. Read the current revision to reconcile them.",
					);
					return;
				}
				knowledgeDraft.set(
					d.submittedVersion !== undefined && (d.editVersion ?? 0) === d.submittedVersion
						? null
						: {
								...d,
								expectedRevision: committed.revision.revision,
								submittedVersion: undefined,
								submittedHash: undefined,
							},
				);
			}
			message.set("Saved a new revision. Sources are not checked or accepted by saving.");
			// Words typed while this request was entered remain an unsent draft.
		} else if (r.state === "rejected") {
			const d = localDraft();
			if (d) knowledgeDraft.set({ ...d, submittedVersion: undefined, submittedHash: undefined });
			message.set(
				"Nothing was saved. Read the current revision and check required headings, sources and limits. Your draft stays.",
			);
		} else message.set("Save outcome unknown. Check only looks up its receipt; it never sends again.");
	};
	const readOperations = async () => {
		const d = localDraft();
		const submitted = d?.submittedVersion !== undefined;
		pending.set(
			await read({
				kind: "pending",
				id: submitted ? d?.id : null,
				expectedRevision: submitted ? d?.expectedRevision : null,
			}),
		);
		operationsKnown.set(true);
	};
	const save = () =>
		run(async () => {
			const d = localDraft();
			if (!d) return;
			const token = generation;
			const submitted = { ...d, submittedVersion: d.editVersion ?? 0, submittedHash: knowledgeFingerprint(d) };
			knowledgeDraft.set(submitted);
			const {
				editVersion: _editVersion,
				submittedVersion: _submittedVersion,
				submittedHash: _submittedHash,
				...edit
			} = submitted;
			// A lost bridge reply may hide the host's operation ID. Read Pending before allowing another Save.
			pending.set([{ operationId: "", id: d.id }]);
			let r: Saved;
			try {
				r = (await send("day.knowledge.save", edit)) as Saved;
			} catch (error) {
				if (token === generation && error instanceof Error && error.message === "stale") {
					const kept = localDraft();
					if (kept) knowledgeDraft.set({ ...kept, submittedVersion: undefined, submittedHash: undefined });
				}
				throw error;
			}
			if (token !== generation || d.projectId !== props.projectId) return;
			settle(r);
			await readOperations();
		});
	const check = (operationId: string) =>
		run(async () => {
			const token = generation;
			const project = props.projectId;
			const r = (await send("day.knowledge.check", { operationId })) as Saved;
			if (token !== generation || project !== props.projectId) return;
			settle(r);
			await readOperations();
		});
	// Restored drafts reconcile their exact submitted operation before Save
	// becomes available. This passive lookup never resends the edit.
	effect(() => {
		const project = props.projectId;
		const opened = libraryOpen();
		if (project && opened)
			untracked(() => {
				void search();
			});
	});
	return (
		<Section
			testID="knowledge"
			title="Knowledge"
			action={
				<Link
					label={libraryOpen() ? "Hide library" : "Open library"}
					testID="knowledge-open"
					onPress={() => {
						libraryOpen.set(!libraryOpen());
					}}
				/>
			}
		>
			<Block>
				<Body tone="muted" measure>
					Sourced project understanding, not agreement or permission. Reading and editing start no AI maintenance.
				</Body>
			</Block>
			<If when={libraryOpen()}>
				<Block gap={3}>
					<Field
						label="Search Knowledge"
						testID="knowledge-query"
						value={query()}
						onChange={(v) => query.set(v)}
					/>
					<Buttons>
						<Button
							label="Search"
							testID="knowledge-search"
							disabled={busy() || !props.projectId}
							onPress={() => void search()}
						/>
					</Buttons>
					<If when={message()}>
						<Caption testID="knowledge-message">{message()}</Caption>
					</If>
				</Block>
				<If when={stale()}>
					<Notice
						kind="unconfirmed"
						placement="section"
						text="Earlier read. Currentness unknown. Read again before relying on it."
					/>
				</If>
				<Each of={pending()} key={(r) => r.operationId}>
					{(r) => (
						<Notice
							kind="needs"
							placement="section"
							text="A Knowledge save is unresolved. Your draft stays; no replacement save will be sent."
							action={
								<If when={r().operationId}>
									<Link
										label="Check save"
										testID="knowledge-check"
										disabled={busy()}
										onPress={() => void check(r().operationId)}
									/>
								</If>
							}
						/>
					)}
				</Each>
				<If when={page() && readProject === props.projectId}>
					<If when={page()?.entries.length === 0}>
						<EmptyLine text="No matching Knowledge in this project." />
					</If>
					<Rows>
						<Each of={page()?.entries ?? []} key={(r) => r.id}>
							{(r) => (
								<Row
									testID={`knowledge-entry-${r().id}`}
									title={r().title}
									meta={`Revision ${r().revision}. ${r().freshness.state === "needs_check" ? "Needs checking" : r().freshness.state === "checked" ? "Checked within stated coverage" : "Not checked"}`}
									accessibilityLabel={`${r().title}, revision ${r().revision}. Read it.`}
									onPress={() => {
										if (!busy()) void open(r().id, r().revision);
									}}
									detail={
										<RowDetail>
											<Caption>{r().synopsis}</Caption>
										</RowDetail>
									}
								/>
							)}
						</Each>
					</Rows>
					<If when={page()?.more}>
						<Block>
							<Link label="Next page" disabled={busy()} onPress={() => void search(page()?.cursor)} />
						</Block>
					</If>
				</If>
				<If when={shown()}>
					{(d) => (
						<Block testID="knowledge-detail" selectable gap={3}>
							<Heading role="header">{d().revision.title}</Heading>
							<Caption>{`Revision ${d().revision.revision}. Latest: ${d().entry.revision}. ${d().revision.revision !== d().entry.revision ? "Historical revision." : ""}`}</Caption>
							<Body tone="muted">
								{d().freshness.state === "checked"
									? `Checked only within this coverage: ${d().freshness.checked?.coverage ?? "Not supplied"}`
									: "Needs checking before reliance. Reading does not check or accept it."}
							</Body>
							<Body measure>{d().revision.body}</Body>
							<Each of={d().freshness.pending?.reasons ?? []} key={(reason) => reason}>
								{(reason) => <Caption>{reason()}</Caption>}
							</Each>
							<If when={d().freshness.failure}>
								<Caption>{`Last check failed: ${d().freshness.failure?.reason}`}</Caption>
							</If>
							<Caption tone="faint">{`Author: ${JSON.stringify(d().revision.author)}. Recorded: ${new Date(d().revision.recordedAt).toLocaleString()}. Origin: ${JSON.stringify(d().entry.origin)}.`}</Caption>
							<Caption>{d().revision.reason ?? "Original revision"}</Caption>
							<BodyStrong>Sources (exact saved records)</BodyStrong>
							<Each of={d().revision.sources} key={(s) => JSON.stringify(s)}>
								{(s) => (
									<View class="gap-1">
										<Caption>{JSON.stringify(s())}</Caption>
										<If when={s().type === "knowledge"}>
											<Link
												label="Open cited Knowledge revision"
												disabled={busy()}
												onPress={() => {
													const source = s();
													if (source.type === "knowledge") void open(source.knowledgeId, source.revision);
												}}
											/>
										</If>
									</View>
								)}
							</Each>
							<Buttons>
								<Button label="Revision history" disabled={busy()} onPress={() => void history()} />
								<Button
									label="Read current revision"
									disabled={busy()}
									onPress={() => void open(d().entry.id)}
								/>
								<Button
									label="Edit this revision"
									testID="knowledge-edit"
									disabled={busy() || !!draft() || d().revision.revision !== d().entry.revision}
									onPress={() => knowledgeDraft.set(editKnowledge(d()))}
								/>
							</Buttons>
							<Each of={revisions()?.revisions ?? []} key={(r) => r.revision}>
								{(r) => (
									<Link
										label={`Revision ${r().revision}: ${r().reason ?? r().title}`}
										disabled={busy()}
										onPress={() => void open(d().entry.id, r().revision)}
									/>
								)}
							</Each>
							<If when={revisions()?.more}>
								<Link
									label="Older revisions"
									disabled={busy()}
									onPress={() => void history(revisions()?.cursor)}
								/>
							</If>
						</Block>
					)}
				</If>
				<If when={draft() && !localDraft()}>
					<Notice
						kind="needs"
						placement="section"
						text="An unsaved Knowledge draft belongs to another project. Return to that project to edit it."
					/>
				</If>
				<If when={localDraft()}>
					{(d) => (
						<Block testID="knowledge-draft" gap={3}>
							<BodyStrong>{`Unsaved edit of ${d().id}, revision ${d().expectedRevision}`}</BodyStrong>
							<Field label="Title" value={d().title} onChange={(v) => change("title", v)} />
							<Field label="Synopsis" value={d().synopsis} onChange={(v) => change("synopsis", v)} />
							<View class="gap-1.5">
								<BodyStrong>Body (Markdown, keep the entry's required headings)</BodyStrong>
								<TextField
									testID="knowledge-body"
									accessibilityLabel="Knowledge body"
									multiline
									value={d().body}
									onChange={({ value }) => change("body", value)}
									rows={8}
								/>
								<Caption>Saved sources stay attached. Editing does not claim they were checked.</Caption>
							</View>
							<Field
								label="Reason for this revision"
								testID="knowledge-reason"
								value={d().reason}
								onChange={(v) => change("reason", v)}
							/>
							<Buttons>
								<Button
									label="Save new revision"
									testID="knowledge-save"
									disabled={busy() || !operationsKnown() || pending().length > 0 || !d().reason.trim()}
									onPress={() => void save()}
								/>
								<Button
									label="Discard draft"
									disabled={busy() || pending().length > 0}
									onPress={() => knowledgeDraft.set(null)}
								/>
								<If
									when={
										shown()?.entry.id === d().id &&
										shown()?.revision.revision === shown()?.entry.revision &&
										(shown()?.revision.revision ?? 0) > d().expectedRevision
									}
								>
									<Button
										label="Keep my draft on this revision"
										disabled={busy() || pending().length > 0}
										onPress={() => {
											const current = shown();
											const kept = localDraft();
											if (current && kept)
												knowledgeDraft.set({
													...kept,
													expectedRevision: current.revision.revision,
													submittedVersion: undefined,
													submittedHash: undefined,
												});
										}}
									/>
								</If>
							</Buttons>
						</Block>
					)}
				</If>
			</If>
		</Section>
	);
}
