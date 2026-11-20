// Settings › Models › Work profiles: kinds of work, each with a large and a small model list. Every change sends the
// whole list once against the revision shown (modelControls.write). Which profile is open and the add form's words
// are kept across reads.
import { effect, signal, untracked, View, type ViewRef } from "nsh";
import type { ProfileModel, WorkProfile, WorkSize } from "../../packages/protocol/src/work-profiles";
import type { ModelControls, ModelSettings } from "./modelControls";
import { settingsReveal, settingsTarget } from "./preferencesView";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	EmptyLine,
	ExpandableRow,
	Field,
	Link,
	Option,
	Options,
	Picker,
	Section,
	Spacer,
} from "./ui";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const word = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);
const SIZES: { size: WorkSize; title: string; detail: string }[] = [
	{ size: "large", title: "Large", detail: "Risky, cross-cutting or design-heavy work." },
	{ size: "small", title: "Small", detail: "Contained work." },
];

/** The open profile and the add form, kept while Settings reads again. */
const openProfile = signal("");
const adding = signal(false);
const addName = signal("");
const addCovers = signal("");

/** A lowercase ID from the name, unique in the list: "Data science" → "data-science". */
export function profileId(name: string, taken: readonly string[]): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/^[^a-z]+/, "")
			.slice(0, 28) || "profile";
	let id = base;
	for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
	return id;
}

function modelName(s: ModelSettings, id: string): string {
	return s.scope.candidates.find((m) => m.id === id)?.name ?? id;
}

/** "Large: Sol, Opus 5.5 · Small: Terra, Sonnet 5.5". */
export function profileSummary(s: ModelSettings, p: WorkProfile): string {
	const names = (list: ProfileModel[]) => list.map((e) => modelName(s, e.model)).join(", ") || "none";
	return `Large: ${names(p.large)} · Small: ${names(p.small)}`;
}

function Entry(props: {
	settings: ModelSettings;
	profile: WorkProfile;
	size: WorkSize;
	entry: ProfileModel;
	disabled: boolean;
	change: (list: ProfileModel[]) => void;
}) {
	const list = () => props.profile[props.size];
	const at = () => list().findIndex((e) => e.model === props.entry.model);
	const id = () => `${props.profile.id}-${props.size}-${props.entry.model}`;
	const signedIn = () => props.settings.scope.candidates.some((m) => m.id === props.entry.model);
	const set = (patch: Partial<ProfileModel>) =>
		props.change(list().map((e) => (e.model === props.entry.model ? { ...e, ...patch } : e)));
	const move = (by: number) => {
		const next = [...list()];
		const [moved] = next.splice(at(), 1);
		next.splice(at() + by, 0, moved!);
		props.change(next);
	};
	return (
		<View testID={`profile-entry-${id()}`} class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
			<Picker
				testID={`profile-model-${id()}`}
				label={`${word(props.size)} model for ${props.profile.name}`}
				items={props.settings.scope.candidates
					.filter((m) => m.id === props.entry.model || !list().some((e) => e.model === m.id))
					.map((m) => ({ value: m.id, title: m.name }))}
				value={props.entry.model}
				placeholder={modelName(props.settings, props.entry.model)}
				searchable
				disabled={props.disabled}
				onChange={(model) => set({ model })}
			/>
			<Picker
				testID={`profile-thinking-${id()}`}
				label={`Thinking for ${modelName(props.settings, props.entry.model)}`}
				items={THINKING.map((level) => ({ value: level, title: word(level) }))}
				value={props.entry.thinking}
				placeholder={word(props.entry.thinking)}
				disabled={props.disabled}
				onChange={(thinking) => set({ thinking })}
			/>
			<If when={!signedIn()}>
				<Caption tone="needs">Not signed in</Caption>
			</If>
			<Spacer />
			<If when={at() > 0}>
				<Link label="Up" testID={`profile-up-${id()}`} onPress={() => !props.disabled && move(-1)} />
			</If>
			<If when={at() < list().length - 1}>
				<Link label="Down" testID={`profile-down-${id()}`} onPress={() => !props.disabled && move(1)} />
			</If>
			<Link
				label="Remove"
				testID={`profile-remove-${id()}`}
				onPress={() => !props.disabled && props.change(list().filter((e) => e.model !== props.entry.model))}
			/>
		</View>
	);
}

function SizeList(props: {
	settings: ModelSettings;
	profile: WorkProfile;
	size: (typeof SIZES)[number];
	disabled: boolean;
	change: (list: ProfileModel[]) => void;
}) {
	const list = () => props.profile[props.size.size];
	const free = () => props.settings.scope.candidates.filter((m) => !list().some((e) => e.model === m.id));
	return (
		<View testID={`profile-${props.profile.id}-${props.size.size}`} class="gap-2">
			<View class="flex-row items-baseline gap-2">
				<BodyStrong>{props.size.title}</BodyStrong>
				<Caption>{props.size.detail}</Caption>
			</View>
			<If when={list().length === 0}>
				<Caption>No models. This size starts your default model.</Caption>
			</If>
			<Each of={list()} key={(e) => e.model}>
				{(e) => (
					<Entry
						settings={props.settings}
						profile={props.profile}
						size={props.size.size}
						entry={e()}
						disabled={props.disabled}
						change={props.change}
					/>
				)}
			</Each>
			<If when={free().length > 0}>
				<View class="flex-row">
					<Picker
						testID={`profile-add-${props.profile.id}-${props.size.size}`}
						label={`Add a ${props.size.size} model to ${props.profile.name}`}
						items={free().map((m) => ({ value: m.id, title: m.name }))}
						value={null}
						placeholder="Add a model"
						searchable
						disabled={props.disabled}
						onChange={(model) => props.change([...list(), { model, thinking: "high" }])}
					/>
				</View>
			</If>
		</View>
	);
}

function ProfileRow(props: {
	settings: ModelSettings;
	profile: WorkProfile;
	disabled: boolean;
	/** This row is where a task line's Change leads. */
	target: boolean;
	save: (next: WorkProfile[]) => void;
}) {
	const p = () => props.profile;
	const open = () => openProfile() === p().id;
	const all = () => props.settings.profiles ?? [];
	const change = (patch: Partial<WorkProfile>) =>
		props.save(all().map((x) => (x.id === p().id ? { ...x, ...patch } : x)));
	const summary = signal<ViewRef | null>(null);
	// Settings scrolls to the summary and gives it the keyboard focus (SettingsScreen.tsx).
	effect(() => {
		const node = summary();
		if (props.target && node) untracked(() => settingsReveal.set(node));
	});
	return (
		<ExpandableRow
			testID={`profile-${p().id}`}
			anchor={(node) => summary.set(node)}
			open={open()}
			onToggle={() => openProfile.set(open() ? "" : p().id)}
			summaryClass="gap-0.5 px-4 py-1.5"
			content={
				<Block gap={4}>
					<Each of={SIZES} key={(s) => s.size}>
						{(size) => (
							<SizeList
								settings={props.settings}
								profile={p()}
								size={size()}
								disabled={props.disabled}
								change={(list) => change({ [size().size]: list })}
							/>
						)}
					</Each>
					<Caption tone="faint">First is preferred when both are equally busy.</Caption>
					<Options multiple>
						<Option
							multiple
							testID={`profile-opt-in-${p().id}`}
							tickTestID={`profile-opt-in-tick-${p().id}`}
							title="Opt-in only"
							hint="Off in every project until you allow it in that project's settings."
							checked={p().optInOnly}
							disabled={props.disabled}
							onChange={() => change({ optInOnly: !p().optInOnly })}
						/>
					</Options>
					<Buttons>
						<Button
							label="Remove profile"
							testID={`profile-delete-${p().id}`}
							disabled={props.disabled}
							onPress={() => props.save(all().filter((x) => x.id !== p().id))}
						/>
					</Buttons>
				</Block>
			}
		>
			<View class="flex-row items-baseline gap-2">
				<BodyStrong>{p().name}</BodyStrong>
				<Caption>{p().covers}</Caption>
			</View>
			<Caption testID={`profile-summary-${p().id}`} tone="faint">
				{`${profileSummary(props.settings, p())}${p().optInOnly ? " · Off until a project allows it" : ""}`}
			</Caption>
		</ExpandableRow>
	);
}

export function WorkProfiles(props: { controls: ModelControls; settings: ModelSettings }) {
	const c = props.controls;
	const s = () => props.settings;
	// An older service sends no profiles.
	const list = () => s().profiles ?? [];
	const disabled = () => c.busy() || c.unknown().length > 0;
	const save = (next: WorkProfile[]) => void c.write("work-profiles", next);
	// A task line's Change: open the profile it named, else the first one.
	const target = () => {
		const t = settingsTarget();
		if (t?.section !== "models") return "";
		return list().some((p) => p.id === t.profile) ? (t.profile as string) : (list()[0]?.id ?? "");
	};
	effect(() => {
		const id = target();
		if (id) untracked(() => openProfile.set(id));
	});
	const section = signal<ViewRef | null>(null);
	effect(() => {
		const node = section();
		if (node && settingsTarget()?.section === "models" && !target()) untracked(() => settingsReveal.set(node));
	});
	const add = async () => {
		const name = addName().trim();
		const covers = addCovers().trim();
		if (!name || !covers) return;
		const id = profileId(
			name,
			list().map((p) => p.id),
		);
		const next = [...list(), { id, name, covers, optInOnly: false, large: [], small: [] }];
		if (await c.write("work-profiles", next)) {
			adding.set(false);
			addName.set("");
			addCovers.set("");
			openProfile.set(id);
		}
	};
	return (
		<View ref={(node: ViewRef) => section.set(node)}>
			<Section
				testID="work-profiles"
				title="Work profiles"
				action={<Link label="Add a profile" testID="profile-add" onPress={() => adding.set(!adding())} />}
			>
				<Block>
					<Body tone="muted" measure>
						The planner gives each task a profile and a size. Pilot starts the model in that list with the fewest
						of your chats working. A model you set on a task wins.
					</Body>
				</Block>
				<If when={list().length === 0}>
					<EmptyLine testID="profiles-empty" text="No work profiles. Every task uses your default model." />
				</If>
				<Each of={list()} key={(p) => p.id}>
					{(p) => (
						<ProfileRow
							settings={s()}
							profile={p()}
							disabled={disabled()}
							target={target() === p().id}
							save={save}
						/>
					)}
				</Each>
				<If when={adding()}>
					<Block testID="profile-form" gap={3}>
						<Field
							label="Name"
							testID="profile-name"
							value={addName()}
							placeholder="Data"
							onChange={addName.set}
						/>
						<Field
							label="What it covers"
							testID="profile-covers"
							value={addCovers()}
							placeholder="Pipelines, warehouse queries and their checks."
							onChange={addCovers.set}
						/>
						<Buttons>
							<Button
								kind="primary"
								label="Add profile"
								testID="profile-save"
								disabled={disabled() || !addName().trim() || !addCovers().trim()}
								onPress={() => void add()}
							/>
							<Button label="Cancel" onPress={() => adding.set(false)} />
						</Buttons>
					</Block>
				</If>
			</Section>
		</View>
	);
}
