// Settings combines native AI controls with this project's preferences. These are small
// choices the user made, which coordinators follow when they plan and work
// in this project. They never give Pilot permission to do anything, and
// they are not shared with other projects.
// The list is edited as one draft that names its project and the revision
// it started from. Save sends that whole list once; a newer list never
// silently replaces typed text, and a draft for another project is never
// saved here. A Save whose answer was lost stays Unknown: Check only reads
// its result. Leaving, closing or updating keeps the draft (windowState.ts).
// Settings is one form page: one panel with one tab per part (AI, Project, Local projects, Tool connections,
// Allowances, Diagnostics & privacy). A tab shows only when this window has its controls.
import { effect, keymap, Scroll, type ScrollRef, signal, untracked, View, type ViewRef } from "nsh";
import { ConnectionSettings } from "./ConnectionSettings";
import { DiagnosisSettings } from "./DiagnosisSettings";
import type { Day } from "./day";
import { FundingSettings } from "./FundingSettings";
import { keepRead, staleLine } from "./freshness";
import { KnowledgeSection } from "./KnowledgeSection";
import { keepField, keepScroll } from "./kept";
import { ModelSettingsSection } from "./ModelSettings";
import { ProjectsSection } from "./ProjectsSection";
import {
	type HistoryPage,
	MAX_ENTRIES,
	MAX_TEXT_BYTES,
	type PreferencesMirror,
	type PreferencesView,
	type ProjectPreference,
	type ProjectPreferences,
	utf8Bytes,
} from "./preferencesFeed";
import {
	changedLine,
	closeSettings,
	type DraftEntry,
	differs,
	draftOf,
	newKey,
	type PreferencesDraft,
	preferencesDraft,
	preferencesMessage,
	quoteOf,
	revisionLine,
	revisionQuote,
	settingsReveal,
	settingsTarget,
	sourceLine,
} from "./preferencesView";
import { SchedulesScreen } from "./SchedulesScreen";
import { ScopedAnswerDrafts } from "./ScopedQuestion";
import { SlackSettings } from "./SlackSettings";
import { schedulesOpen } from "./scheduleDraft";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	EmptyLine,
	Fact,
	Facts,
	glide,
	Link,
	Notice,
	Page,
	PageFoot,
	PageHead,
	Panel,
	Quote,
	Row,
	RowDetail,
	Rows,
	Section,
	Spacer,
	Tab,
	Tabs,
	TextField,
} from "./ui";

/** The new row that takes the keyboard focus once. */
const focusRow = signal<string | null>(null);
/** Whether the user asked to discard a draft kept for another project. */
const discardAsk = signal(false);

/** The project's preferences: the list, its sources and one explicit Save. */
function Preferences(props: { mirror: PreferencesMirror }) {
	const v = (): PreferencesView => props.mirror.view();
	const read = (): ProjectPreferences | null => v().preferences;
	// Pilot reads again on its own after a failed read, and when the window comes back.
	const reads = keepRead(
		() => props.mirror.source.read(),
		() => !!v().reason,
		() => !!read(),
	);
	const name = () => v().projectName || "this project";
	/** A kept draft for another project than this window's: shown, never saved here. */
	const elsewhere = () => {
		const d = preferencesDraft();
		return !!d && v().projectId !== "" && d.projectId !== v().projectId;
	};
	/** The draft when it says something other than the saved list. */
	const dirty = (): PreferencesDraft | null => {
		const d = preferencesDraft();
		if (!d || elsewhere()) return null;
		return differs(d, read()) ? d : null;
	};
	/** A newer list was saved since the draft started. */
	const conflict = () => {
		const d = dirty();
		const p = read();
		return !!d && !!p && d.baseRevision !== p.revision;
	};
	const unsettled = () => v().unsettled;
	const editable = () => !elsewhere() && !v().saving && (!!read() || !!dirty());
	const rows = (): DraftEntry[] => {
		const d = dirty();
		if (d) return d.entries;
		const p = read();
		return p ? draftOf(p).entries : [];
	};
	/** The draft to change: the kept one, or a fresh copy of the list shown. */
	const begin = (): PreferencesDraft | null => {
		const d = dirty();
		if (d) return d;
		const p = read();
		return p ? draftOf(p) : null;
	};
	const change = (next: (d: PreferencesDraft) => PreferencesDraft) => {
		const d = begin();
		if (!d || !editable()) return;
		preferencesMessage.set("");
		preferencesDraft.set(next(d));
	};
	const edit = (key: string, text: string) =>
		change((d) => ({ ...d, entries: d.entries.map((e) => (e.key === key ? { ...e, text } : e)) }));
	const remove = (key: string) => {
		glide();
		change((d) => ({ ...d, entries: d.entries.filter((e) => e.key !== key) }));
	};
	const addRow = () => {
		const key = newKey();
		glide();
		focusRow.set(key);
		change((d) => ({ ...d, entries: [...d.entries, { key, id: null, text: "" }] }));
	};
	const revert = () => {
		glide();
		preferencesDraft.set(null);
		preferencesMessage.set("");
	};
	const tooLong = (text: string) => utf8Bytes(text) > MAX_TEXT_BYTES;
	/** Why Save cannot send the draft now, or "". */
	const blocker = () => {
		const d = dirty();
		if (!d) return "";
		if (unsettled().length > 0) return "Check your earlier change first. Your text stays.";
		if (!read()) return "Pilot can save once it reads this project's preferences again. Your text stays.";
		if (conflict()) return "Choose which version to keep first.";
		if (d.entries.some((e) => e.text.trim() === ""))
			return "Write something in each preference, or remove the empty one.";
		if (d.entries.some((e) => tooLong(e.text)))
			return `A preference is too long. Keep each under ${MAX_TEXT_BYTES} bytes.`;
		if (d.entries.length > MAX_ENTRIES) return `A project keeps at most ${MAX_ENTRIES} preferences.`;
		return "";
	};
	const canSave = () => !!dirty() && !v().saving && blocker() === "";
	const save = async () => {
		const d = dirty();
		if (!d || !canSave()) return;
		preferencesMessage.set("");
		const r = await props.mirror.source.save({
			projectId: d.projectId,
			expectedRevision: d.baseRevision,
			entries: d.entries.map((e) => ({ id: e.id, text: e.text })),
		});
		// Only an accepted receipt clears the draft, and only the draft that was sent.
		if (r.status === "accepted" && preferencesDraft() === d) preferencesDraft.set(null);
		// An Unknown save shows as its own note, with Check.
		preferencesMessage.set(r.status === "unknown" && unsettled().length > 0 ? "" : r.message);
	};
	const check = async (operationId: string) => {
		preferencesMessage.set("");
		const r = await props.mirror.source.check(operationId);
		if (r.status === "accepted" && r.saved) {
			const d = preferencesDraft();
			if (d && !differs(d, r.saved)) preferencesDraft.set(null);
		}
		preferencesMessage.set(r.status === "accepted" ? "Your change was saved." : r.message);
		void props.mirror.source.read();
	};
	keymap.bind(
		"mod+s",
		() => {
			if (canSave()) void save();
		},
		{ when: "always" },
	);
	/** What one row says under its text: where it came from, or that it is not saved. */
	const meta = (e: DraftEntry): string => {
		const was = e.id ? read()?.entries.find((x) => x.id === e.id) : undefined;
		if (!was) return "New · not saved";
		if (was.text !== e.text) return "Edited · not saved";
		return sourceLine(was);
	};
	const savedOf = (e: DraftEntry): ProjectPreference | undefined =>
		e.id ? read()?.entries.find((x) => x.id === e.id && x.text === e.text) : undefined;
	return (
		<Section
			testID="preferences"
			title="Project preferences"
			footnote={!dirty() && read() ? changedLine(read() as ProjectPreferences) || undefined : undefined}
			footnoteTestID="preferences-changed"
			action={
				<If when={reads.warn()}>
					<Link
						label={v().reading ? "Reading…" : "Try now"}
						icon="refresh"
						testID="preferences-read"
						disabled={v().reading}
						accessibilityLabel="Read this project's preferences again. This sends nothing."
						onPress={() => void reads.now()}
					/>
				</If>
			}
		>
			<Block>
				<Body tone="muted" measure>
					{`Small choices you made for ${name()}. Coordinators follow them when they plan and work in this project. They never give Pilot permission to do anything.`}
				</Body>
				<Facts>
					<Fact label="Project" testID="preferences-project">
						{v().projectName || (read() ? "This window's project" : "")}
					</Fact>
				</Facts>
			</Block>
			<If when={elsewhere()}>
				<Notice
					testID="preferences-elsewhere"
					kind="needs"
					placement="section"
					text="You have unsaved preferences for another project."
					detail={`This window saves only ${name()}'s preferences. They stay unsaved until you discard them.`}
					otherAction={
						<If when={discardAsk()}>
							<Button
								small
								kind="destructive"
								label="Discard for good"
								testID="preferences-elsewhere-confirm"
								onPress={() => {
									discardAsk.set(false);
									preferencesDraft.set(null);
								}}
							/>
						</If>
					}
					action={
						<If
							when={discardAsk()}
							else={
								<Link
									label="Discard them"
									testID="preferences-elsewhere-discard"
									onPress={() => discardAsk.set(true)}
								/>
							}
						>
							<Button
								small
								label="Keep them"
								testID="preferences-elsewhere-keep"
								onPress={() => discardAsk.set(false)}
							/>
						</If>
					}
				/>
			</If>
			<If when={v().reason && (!read() || reads.stale())}>
				<Notice
					testID="preferences-off"
					kind="needs"
					placement="section"
					text={
						read()
							? staleLine(reads.readAt() ?? 0)
							: `Pilot cannot show this project's preferences. ${v().reason}`
					}
					detail={read() ? undefined : "This is not the same as having none."}
				/>
			</If>
			<Each of={unsettled()} key={(o) => o.operationId}>
				{(o) => (
					<Notice
						testID="preferences-unknown"
						kind="needs"
						placement="section"
						text={
							o().state === "checking"
								? "Checking that your last change was saved…"
								: "Pilot does not know if your last change was saved."
						}
						detail="It will not send it again. Check only reads its result. Your text stays here."
						action={
							// Pilot checks by itself first; Check is the fallback after its tries.
							<If when={o().state !== "checking"}>
								<Link label="Check" testID="preferences-check" onPress={() => void check(o().operationId)} />
							</If>
						}
					/>
				)}
			</Each>
			<If when={conflict()}>
				<Notice
					testID="preferences-conflict"
					kind="needs"
					placement="section"
					text="These preferences changed since you started editing. Nothing was saved; your text is kept."
					detail="Saved now:"
				/>
				<Block>
					<Quote>
						<Each of={read()?.entries ?? []} key={(e) => e.id}>
							{(e) => <Body tone="muted">{`• ${e().text}`}</Body>}
						</Each>
					</Quote>
					<Buttons>
						<Button
							label="Keep my version"
							testID="preferences-keep-mine"
							onPress={() => {
								const d = dirty();
								const p = read();
								if (d && p) preferencesDraft.set({ ...d, baseRevision: p.revision });
							}}
						/>
						<Button label="Use the saved version" testID="preferences-use-saved" onPress={revert} />
					</Buttons>
				</Block>
			</If>
			<If
				when={read() || dirty()}
				else={
					<If when={!v().reason}>
						<EmptyLine text={`Reading ${name()}'s preferences…`} />
					</If>
				}
			>
				<View testID="preferences-list">
					<If when={rows().length === 0}>
						<EmptyLine
							testID="preferences-empty"
							text="No preferences yet. Add one here. A mission's coordinator can also record one, quoting a note you wrote in that mission."
						/>
					</If>
					<Each of={rows()} key={(e) => e.key}>
						{(e) => {
							const field = keepField(
								`preference-${e().key}`,
								() => "settings",
								() => e().text,
							);
							return (
								<Block testID={`preference-row-${e().key}`} gap={1}>
									<TextField
										testID={`preference-${e().key}`}
										ref={field.ref}
										multiline
										autoFocus={focusRow() === e().key}
										readonly={!editable()}
										value={e().text}
										invalid={tooLong(e().text)}
										accessibilityLabel="A preference for this project"
										placeholder="Write one short preference"
										onChange={({ value }) => edit(e().key, value)}
										onFocus={() => {
											field.focus();
											if (focusRow() === e().key) focusRow.set(null);
										}}
										onSelectionChange={field.select}
									/>
									<If when={tooLong(e().text)}>
										<Caption tone="failed">{`Too long. Keep it under ${MAX_TEXT_BYTES} bytes.`}</Caption>
									</If>
									<View class="flex-row items-center gap-2">
										<Caption tone="faint">{meta(e())}</Caption>
										<Spacer />
										<If when={editable()}>
											<Button
												small
												label="Remove"
												testID={`preference-remove-${e().key}`}
												accessibilityLabel="Remove this preference. Nothing is saved until you press Save."
												onPress={() => remove(e().key)}
											/>
										</If>
									</View>
									<If when={savedOf(e()) && quoteOf(savedOf(e()) as ProjectPreference)}>
										<Caption tone="faint">
											{`Your words: “${quoteOf(savedOf(e()) as ProjectPreference)}”`}
										</Caption>
									</If>
									<If when={savedOf(e())}>
										<Caption tone="faint">{`Source: ${JSON.stringify(savedOf(e())?.source)}`}</Caption>
									</If>
								</Block>
							);
						}}
					</Each>
					<Block>
						<View class="flex-row items-center gap-3">
							<Button
								label="Add a preference"
								icon="plus"
								testID="preference-add"
								disabled={!editable() || rows().length >= MAX_ENTRIES}
								onPress={addRow}
							/>
							<If when={rows().length >= MAX_ENTRIES}>
								<Caption tone="faint">{`A project keeps at most ${MAX_ENTRIES}.`}</Caption>
							</If>
						</View>
					</Block>
				</View>
			</If>
			<If when={dirty()}>
				<Block testID="preferences-unsaved">
					<Body>{blocker() || `Unsaved. Save replaces ${name()}'s preferences with this list.`}</Body>
					<Buttons>
						<Button
							kind="primary"
							label={v().saving ? "Saving…" : "Save"}
							shortcut={keymap.label("mod+s")}
							testID="preferences-save"
							disabled={!canSave()}
							onPress={() => void save()}
						/>
						<Button label="Revert" testID="preferences-revert" disabled={v().saving} onPress={revert} />
					</Buttons>
				</Block>
			</If>
			<If when={preferencesMessage()}>
				<Block>
					<Caption testID="preferences-message">{preferencesMessage()}</Caption>
				</Block>
			</If>
		</Section>
	);
}

/** Whether the history shows, the pages read and why a read failed. Reads only. */
const historyOpen = signal(false);
const historyPages = signal<HistoryPage[]>([]);
const historyError = signal("");
const historyReading = signal(false);
const openRevision = signal<number | null>(null);

/** The list's saved revisions, newest first, read only. Nothing here restores or saves. */
function History(props: { mirror: PreferencesMirror }) {
	const current = () => props.mirror.view().preferences?.revision ?? null;
	let asked = 0;
	const load = async (before?: number) => {
		const mine = ++asked;
		historyReading.set(true);
		historyError.set("");
		const r = await props.mirror.source.history(before);
		if (mine !== asked) return;
		historyReading.set(false);
		if (!r.ok) {
			historyError.set(r.reason);
			return;
		}
		glide();
		historyPages.set(before === undefined ? [r.page] : [...historyPages(), r.page]);
	};
	// A newer saved list makes the history shown older: read it again from the newest.
	let seen = untracked(current);
	effect(() => {
		const now = current();
		if (now === seen) return;
		seen = now;
		if (untracked(historyOpen)) void load();
	});
	const revisions = () => historyPages().flatMap((p) => p.revisions);
	const next = () => historyPages().at(-1);
	return (
		<Section
			testID="preferences-history"
			title="History"
			action={
				<Link
					label={historyOpen() ? "Hide history" : "Show history"}
					testID="preferences-history-toggle"
					accessibilityLabel={
						historyOpen()
							? "Hide this project's earlier preferences"
							: "Show this project's earlier preferences. This only reads."
					}
					onPress={() => {
						glide();
						const open = !historyOpen();
						historyOpen.set(open);
						if (open) void load();
					}}
				/>
			}
			more={
				historyOpen() && !historyReading() && next()?.more && next()?.before
					? {
							label: "Show earlier",
							testID: "preferences-history-more",
							onPress: () => void load(next()?.before ?? undefined),
						}
					: undefined
			}
		>
			<If when={historyOpen()}>
				<If when={historyError()}>
					<Notice
						testID="preferences-history-off"
						kind="needs"
						placement="section"
						text={historyError()}
						detail="This is not the same as having no history."
					/>
				</If>
				<If when={!historyError() && !historyReading() && revisions().length === 0}>
					<EmptyLine testID="preferences-history-empty" text="No saved changes yet." />
				</If>
				<Rows>
					<Each of={revisions()} key={(r) => String(r.revision)}>
						{(r) => (
							<Row
								testID={`preferences-revision-${r().revision}`}
								title={revisionLine(r())}
								meta={r().reason ?? undefined}
								selected={openRevision() === r().revision}
								accessibilityLabel={`${revisionLine(r())}. ${openRevision() === r().revision ? "Hide" : "Show"} the list it saved.`}
								onPress={() => {
									glide();
									openRevision.set(openRevision() === r().revision ? null : r().revision);
								}}
								detail={
									<If when={openRevision() === r().revision}>
										<RowDetail testID={`preferences-revision-detail-${r().revision}`}>
											<If when={r().entries.length === 0}>
												<Caption>No preferences.</Caption>
											</If>
											<Each of={r().entries} key={(e) => e.id}>
												{(e) => (
													<View selectable class="gap-0.5">
														<Body tone="muted">{`• ${e().text}`}</Body>
														<Caption tone="faint">{`Source: ${JSON.stringify(e().source)}. ${sourceLine(e())}`}</Caption>
													</View>
												)}
											</Each>
											<If when={revisionQuote(r())}>
												<Caption tone="faint">{`From your note: “${revisionQuote(r())}”`}</Caption>
											</If>
										</RowDetail>
									</If>
								}
							/>
						)}
					</Each>
				</Rows>
				<If when={historyReading()}>
					<EmptyLine text="Reading history…" />
				</If>
			</If>
		</Section>
	);
}

/** Settings' tabs, in order. Each shows only when this window has its controls. */
type SettingsTab = "ai" | "project" | "projects" | "connections" | "allowances" | "diagnosis";
const TABS: { id: SettingsTab; label: string }[] = [
	{ id: "ai", label: "AI" },
	{ id: "project", label: "Project" },
	{ id: "projects", label: "Local projects" },
	{ id: "connections", label: "Tool connections" },
	{ id: "allowances", label: "Allowances" },
	{ id: "diagnosis", label: "Diagnostics & privacy" },
];
/** The tab the user chose, kept while the window is open. Null shows the first tab this window has. */
const settingsTab = signal<SettingsTab | null>(null);

/** Settings over the window's preferences. Opening it only reads. */
export function SettingsScreen(props: { day: Day; onBackFromJump?: () => boolean }) {
	const mirror = props.day.preferences as PreferencesMirror;
	void mirror.source.read();
	keymap.bind("escape", () => {
		if (schedulesOpen()) schedulesOpen.set(false);
		else if (!props.onBackFromJump?.()) closeSettings();
	});
	const scroll = keepScroll("settings");
	// A restored offset waits for the rows it scrolled through. A target (a task line's Change) wins over it.
	let waiting = scroll.contentOffset.y > 0 && !untracked(settingsTarget) ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const node = scroller();
		if (waiting === null || !node || !mirror.view().preferences) return;
		const y = waiting;
		waiting = null;
		node.scrollTo({ y, animated: false });
	});
	// Opened at a target: scroll its view to the top of the screen once, and give it the keyboard focus.
	const root = signal<ViewRef | null>(null);
	effect(() => {
		const node = settingsReveal();
		const s = scroller();
		const r = root();
		if (!node || !s || !r) return;
		untracked(() => {
			settingsReveal.set(null);
			settingsTarget.set(null);
			void Promise.all([node.measure(), r.measure()])
				.then(([n, top]) => {
					if (n && top)
						s.scrollTo({ y: Math.max(0, n.pagePosition.y - top.pagePosition.y - 24), animated: false });
					node.focus();
				})
				.catch(() => {});
		});
	});
	const has = (tab: SettingsTab): boolean => {
		if (tab === "ai" || tab === "allowances") return !!props.day.models;
		if (tab === "connections") return !!props.day.connections || !!props.day.slack;
		if (tab === "diagnosis") return !!props.day.diagnosis;
		return true;
	};
	const tabs = () => TABS.filter((t) => has(t.id));
	const tab = (): SettingsTab => {
		const chosen = settingsTab();
		return chosen && has(chosen) ? chosen : (tabs()[0]?.id ?? "project");
	};
	// A target (a task line's Change) names a work profile: the AI tab holds it.
	effect(() => {
		if (settingsTarget()?.section === "models" && has("ai")) untracked(() => settingsTab.set("ai"));
	});
	return (
		<If
			when={schedulesOpen() && props.day.schedules}
			else={
				<Scroll
					ref={(node) => scroller.set(node)}
					class="flex-1"
					contentOffset={scroll.contentOffset}
					scrollEventThrottle={100}
					onScroll={(e) => {
						if (waiting === null) scroll.onScroll(e);
					}}
				>
					<View ref={(node: ViewRef) => root.set(node)}>
						<Page testID="settings" width="form">
							<PageHead
								title="Settings"
								actions={
									<If when={props.day.schedules}>
										<Button
											label="Schedules…"
											testID="settings-schedules"
											onPress={() => schedulesOpen.set(true)}
										/>
									</If>
								}
							>
								<ScopedAnswerDrafts />
							</PageHead>
							<Panel
								testID="settings-panel"
								tabs={
									<Tabs>
										<Each of={tabs()} key={(t) => t.id}>
											{(t) => (
												<Tab
													label={t().label}
													testID={`settings-tab-${t().id}`}
													selected={tab() === t().id}
													onPress={() => {
														glide();
														settingsTab.set(t().id);
													}}
												/>
											)}
										</Each>
									</Tabs>
								}
							>
								<Column>
									<If when={tab() === "ai" ? props.day.models : undefined}>
										{(controls) => <ModelSettingsSection controls={controls()} />}
									</If>
									<If when={tab() === "project"}>
										<Preferences mirror={mirror} />
										<History mirror={mirror} />
										<KnowledgeSection projectId={mirror.view().projectId} />
									</If>
									<If when={tab() === "projects"}>
										<ProjectsSection />
									</If>
									<If when={tab() === "connections"}>
										<If when={props.day.connections}>
											{(controls) => <ConnectionSettings controls={controls()} />}
										</If>
										<If when={props.day.slack}>{(controls) => <SlackSettings controls={controls()} />}</If>
									</If>
									<If when={tab() === "allowances" ? props.day.models : undefined}>
										{(controls) => <FundingSettings controls={controls()} standalone />}
									</If>
									<If when={tab() === "diagnosis" ? props.day.diagnosis : undefined}>
										{(controls) => <DiagnosisSettings controls={controls()} />}
									</If>
								</Column>
							</Panel>
							<PageFoot text="Preferences are what you chose. Pilot's approvals, Stop and spending limits still apply." />
						</Page>
					</View>
				</Scroll>
			}
		>
			<SchedulesScreen controls={props.day.schedules!} />
		</If>
	);
}
