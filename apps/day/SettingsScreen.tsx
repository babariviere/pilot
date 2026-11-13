// Settings: for now one section, this project's preferences. They are small
// choices the user made, which coordinators follow when they plan and work
// in this project. They never give Pilot permission to do anything, and
// they are not shared with other projects.
// The list is edited as one draft that names its project and the revision
// it started from. Save sends that whole list once; a newer list never
// silently replaces typed text, and a draft for another project is never
// saved here. A Save whose answer was lost stays Unknown: Check only reads
// its result. Leaving, closing or updating keeps the draft (updateView.ts).
import { effect, type JSX, keymap, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Day } from "./day";
import { keepField, keepScroll } from "./kept";
import { glide } from "./motion";
import {
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
	sourceLine,
} from "./preferencesView";
import { Action, Mark, SectionTitle } from "./ui";

/** A quiet note with a mark, for what needs a look. */
function Note(props: { testID: string; text: string; detail?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="gap-2 rounded-xl bg-muted px-4 py-3">
			<View class="flex-row items-center gap-2.5">
				<Mark kind="unknown" />
				<Text class="flex-1 text-sm text-foreground">{props.text}</Text>
			</View>
			<If when={props.detail}>
				<Text class="text-xs text-faint">{props.detail ?? ""}</Text>
			</If>
			{props.children}
		</View>
	);
}

/** The new row that takes the keyboard focus once. */
const focusRow = signal<string | null>(null);
/** Whether the user asked to discard a draft kept for another project. */
const discardAsk = signal(false);

/** The project's preferences: the list, its sources and one explicit Save. */
function Preferences(props: { mirror: PreferencesMirror }) {
	const v = (): PreferencesView => props.mirror.view();
	const read = (): ProjectPreferences | null => v().preferences;
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
		<View testID="preferences" class="gap-5">
			<View class="gap-1.5">
				<SectionTitle title="Project preferences" />
				<Text class="text-sm leading-relaxed text-muted-foreground">
					{`Small choices you made for ${name()}. Coordinators follow them when they plan and work in this project. They never give Pilot permission to do anything.`}
				</Text>
			</View>
			<View class="flex-row items-baseline gap-3 border-t border-border pt-3">
				<Text class="text-sm text-muted-foreground">Project</Text>
				<Text testID="preferences-project" class="flex-1 text-sm font-medium text-foreground">
					{v().projectName || (read() ? "This window's project" : "")}
				</Text>
				<Action
					label={v().reading ? "Reading…" : "Read again"}
					icon="refresh"
					testID="preferences-read"
					disabled={v().reading}
					accessibilityLabel="Read this project's preferences again. This sends nothing."
					onPress={() => void props.mirror.source.read()}
				/>
			</View>
			<If when={elsewhere()}>
				<Note
					testID="preferences-elsewhere"
					text="You have unsaved preferences for another project."
					detail={`This window saves only ${name()}'s preferences. They stay unsaved until you discard them.`}
				>
					<View class="flex-row gap-2">
						<If
							when={discardAsk()}
							else={
								<Action
									label="Discard them"
									testID="preferences-elsewhere-discard"
									onPress={() => discardAsk.set(true)}
								/>
							}
						>
							<Action
								label="Discard for good"
								testID="preferences-elsewhere-confirm"
								onPress={() => {
									discardAsk.set(false);
									preferencesDraft.set(null);
								}}
							/>
							<Action
								label="Keep them"
								testID="preferences-elsewhere-keep"
								onPress={() => discardAsk.set(false)}
							/>
						</If>
					</View>
				</Note>
			</If>
			<If when={v().reason}>
				<Note
					testID="preferences-off"
					text={read() ? v().reason : `Pilot cannot show this project's preferences. ${v().reason}`}
					detail={read() ? undefined : "This is not the same as having none."}
				/>
			</If>
			<Each of={unsettled()} key={(o) => o.operationId}>
				{(o) => (
					<Note
						testID="preferences-unknown"
						text="Pilot does not know if your last change was saved."
						detail="It will not send it again. Check only reads its result. Your text stays here."
					>
						<View class="flex-row">
							<Action
								label={o().state === "checking" ? "Checking…" : "Check"}
								testID="preferences-check"
								disabled={o().state === "checking"}
								onPress={() => void check(o().operationId)}
							/>
						</View>
					</Note>
				)}
			</Each>
			<If when={conflict()}>
				<Note
					testID="preferences-conflict"
					text="These preferences changed since you started editing. Nothing was saved; your text is kept."
					detail="Saved now:"
				>
					<View class="gap-1">
						<Each of={read()?.entries ?? []} key={(e) => e.id}>
							{(e) => <Text class="text-sm text-muted-foreground">{`• ${e().text}`}</Text>}
						</Each>
					</View>
					<View class="flex-row gap-2 pt-1">
						<Action
							label="Keep my version"
							testID="preferences-keep-mine"
							onPress={() => {
								const d = dirty();
								const p = read();
								if (d && p) preferencesDraft.set({ ...d, baseRevision: p.revision });
							}}
						/>
						<Action label="Use the saved version" testID="preferences-use-saved" onPress={revert} />
					</View>
				</Note>
			</If>
			<If
				when={read() || dirty()}
				else={
					<If when={!v().reason}>
						<Text class="text-sm text-muted-foreground">{`Reading ${name()}'s preferences…`}</Text>
					</If>
				}
			>
				<View testID="preferences-list">
					<If when={rows().length === 0}>
						<Text testID="preferences-empty" class="border-t border-border py-3.5 text-sm text-muted-foreground">
							No preferences yet. Add one here. A mission's coordinator can also record one, quoting a note you
							wrote in that mission.
						</Text>
					</If>
					<Each of={rows()} key={(e) => e.key}>
						{(e) => {
							const field = keepField(
								`preference-${e().key}`,
								() => "settings",
								() => e().text,
							);
							return (
								<View testID={`preference-row-${e().key}`} class="gap-1.5 border-t border-border py-3">
									<Input
										testID={`preference-${e().key}`}
										ref={field.ref}
										multiline
										autoFocus={focusRow() === e().key}
										readonly={!editable()}
										value={e().text}
										accessibilityLabel="A preference for this project"
										placeholder="Write one short preference"
										onChange={({ value }) => edit(e().key, value)}
										onFocus={() => {
											field.focus();
											if (focusRow() === e().key) focusRow.set(null);
										}}
										onSelectionChange={field.select}
										class="min-h-9 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary"
									/>
									<If when={tooLong(e().text)}>
										<Text class="text-xs text-needs-ink">{`Too long. Keep it under ${MAX_TEXT_BYTES} bytes.`}</Text>
									</If>
									<View class="flex-row items-center gap-2">
										<Text class="flex-1 text-xs text-faint">{meta(e())}</Text>
										<If when={editable()}>
											<Action
												label="Remove"
												testID={`preference-remove-${e().key}`}
												accessibilityLabel="Remove this preference. Nothing is saved until you press Save."
												onPress={() => remove(e().key)}
											/>
										</If>
									</View>
									<If when={savedOf(e()) && quoteOf(savedOf(e()) as ProjectPreference)}>
										<Text class="text-xs text-faint">
											{`Your words: “${quoteOf(savedOf(e()) as ProjectPreference)}”`}
										</Text>
									</If>
								</View>
							);
						}}
					</Each>
					<View class="flex-row items-center gap-3 border-t border-border pt-3">
						<Action
							label="Add a preference"
							icon="plus"
							testID="preference-add"
							disabled={!editable() || rows().length >= MAX_ENTRIES}
							onPress={addRow}
						/>
						<If when={rows().length >= MAX_ENTRIES}>
							<Text class="text-xs text-faint">{`A project keeps at most ${MAX_ENTRIES}.`}</Text>
						</If>
					</View>
				</View>
			</If>
			<If
				when={dirty()}
				else={
					<If when={read() && changedLine(read() as ProjectPreferences)}>
						<Text testID="preferences-changed" class="text-xs text-faint">
							{read() ? changedLine(read() as ProjectPreferences) : ""}
						</Text>
					</If>
				}
			>
				<View testID="preferences-unsaved" class="gap-2 rounded-xl border border-border px-4 py-3">
					<Text class="text-sm text-foreground">
						{blocker() || `Unsaved. Save replaces ${name()}'s preferences with this list.`}
					</Text>
					<View class="flex-row gap-2">
						<Action
							primary
							label={v().saving ? "Saving…" : "Save"}
							shortcut={keymap.label("mod+s")}
							testID="preferences-save"
							disabled={!canSave()}
							onPress={() => void save()}
						/>
						<Action label="Revert" testID="preferences-revert" disabled={v().saving} onPress={revert} />
					</View>
				</View>
			</If>
			<If when={preferencesMessage()}>
				<Text testID="preferences-message" class="text-xs text-muted-foreground">
					{preferencesMessage()}
				</Text>
			</If>
		</View>
	);
}

/** Settings over the window's preferences. Opening it only reads. */
export function SettingsScreen(props: { day: Day }) {
	const mirror = props.day.preferences as PreferencesMirror;
	void mirror.source.read();
	keymap.bind("escape", closeSettings);
	const scroll = keepScroll("settings");
	// A restored offset waits for the rows it scrolled through.
	let waiting = scroll.contentOffset.y > 0 ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const node = scroller();
		if (waiting === null || !node || !mirror.view().preferences) return;
		const y = waiting;
		waiting = null;
		node.scrollTo({ y, animated: false });
	});
	return (
		<Scroll
			ref={(node) => scroller.set(node)}
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={(e) => {
				if (waiting === null) scroll.onScroll(e);
			}}
		>
			<View testID="settings" class="w-full max-w-2xl self-center gap-10 px-6 pb-24 pt-10">
				<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
					Settings
				</Text>
				<Preferences mirror={mirror} />
				<Text class="border-t border-border pt-5 text-xs text-faint">
					Preferences are what you chose. Pilot's approvals, Stop and spending limits still apply.
				</Text>
			</View>
		</Scroll>
	);
}
