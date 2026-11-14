// New: the user says what they want, then picks how it starts. A mission
// starts with a complete saved interview in the chosen project; build
// work needs a separate exact-plan Start. A small ask starts one chat in the
// project the user chose, after they confirm the exact words, project and
// access. Choosing a project only reads its setup: nothing starts, and no
// existing chat moves or changes what it may do. The user always chooses the
// project: New never picks one, so both starts wait for that choice.
import { cleanup, effect, keymap, Scroll, Text, untracked, View } from "nsh";
import { Input, RadioGroup } from "nsh/base";
import {
	checkNewChat,
	chooseChat,
	dropChoice,
	modeWords,
	prepareChat,
	projectName,
	startNewChat,
} from "./chatCommands";
import type { ChatMode } from "./chatFeed";
import { keepField, keepScroll } from "./kept";
import { glide } from "./motion";
import { stageMark, stageWord } from "./PlanScreen";
import { checkCreation, planMission } from "./planCommands";
import type { Plans } from "./planning";
import {
	chatChoice,
	chatNote,
	chatPick,
	chatSelecting,
	closePlanning,
	confirmingStart,
	goalDraft,
	newBusy,
	newMessage,
	openPlan,
	projectsOpen,
	replacesDraft,
} from "./planView";
import { Action, Mark, Picker, RadioRow, RowLink, SectionTitle } from "./ui";

const MODES: { mode: ChatMode; label: string }[] = [
	{ mode: "build", label: modeWords("build") },
	{ mode: "ask", label: modeWords("ask") },
];

/** The project a new chat goes to: a list of the user's projects, and where the chosen one lives. */
function ProjectRow(props: { plans: Plans }) {
	const chats = props.plans.chats;
	const view = () => chats.view();
	const chosen = () => view().projects.find((p) => p.projectId === chatPick()?.projectId) ?? null;
	const items = () => view().projects.map((p) => ({ value: p.projectId, title: p.name }));
	const placeholder = () => (view().availability === "reading" ? "Reading projects…" : "Choose a project");
	const where = () => {
		const c = chosen();
		if (c) return c.projectPath;
		return view().availability === "live" && !chatPick() ? "No project is chosen for you." : "";
	};
	return (
		<View testID="new-project" class="gap-1.5">
			<View class="flex-row items-center gap-2.5">
				<Text class="text-xs text-faint">Project</Text>
				<Picker
					testID="project"
					label="Project for a new chat"
					items={items()}
					value={chosen()?.projectId ?? null}
					placeholder={placeholder()}
					disabled={view().availability !== "live" || view().projects.length === 0 || newBusy() || view().creating}
					searchable={view().projects.length > 8}
					searchPlaceholder="Find a project"
					detail={(id) => view().projects.find((p) => p.projectId === id)?.projectPath ?? ""}
					onOpenChange={(open) => projectsOpen.set(open)}
					onChange={(id) => {
						if (id === chatPick()?.projectId && chatChoice()) return;
						glide();
						void chooseChat(chats, { projectId: id, mode: chatPick()?.mode ?? "build" });
					}}
				/>
				<View selectable class="flex-1">
					<Text testID="project-where" class="truncate text-xs text-faint">
						{where()}
					</Text>
				</View>
			</View>
			<If when={view().availability === "unavailable"}>
				<View testID="projects-off" class="flex-row items-center gap-2.5">
					<Mark kind="unknown" />
					<Text class="flex-1 text-sm text-muted-foreground">{`Pilot cannot list your projects here. ${view().reason}`}</Text>
					<Action label="Read again" disabled={newBusy()} onPress={() => void prepareChat(chats)} />
				</View>
			</If>
			<If when={chatNote()}>
				<Text testID="project-note" class="text-xs text-needs-ink">
					{chatNote()}
				</Text>
			</If>
		</View>
	);
}

/** The confirmation of a direct start: exactly what starts, where, and what it may do. */
function ConfirmStart(props: { plans: Plans }) {
	const chats = props.plans.chats;
	const view = () => chats.view();
	const choice = () => chatChoice();
	const mode = () => chatPick()?.mode ?? "build";
	const where = () => {
		const c = choice();
		if (c) return `${projectName(view(), c.projectId)} · ${c.model}${c.thinking ? ` · ${c.thinking} thinking` : ""}`;
		return chatSelecting() ? "Reading this project's setup…" : "Choose a project first.";
	};
	const ready = () => !!choice() && !chatSelecting() && view().unsettled.length === 0 && !view().creating;
	return (
		<View testID="confirm-start" class="gap-3 rounded-2xl border border-border-strong bg-card px-5 py-4">
			<Text class="text-sm font-medium text-card-foreground">Start one chat with exactly these words?</Text>
			<View selectable class="rounded-lg bg-muted px-3 py-2">
				<Text class="text-sm text-foreground">{goalDraft()}</Text>
			</View>
			<View class="gap-1">
				<Text class="text-xs text-faint">What it may do</Text>
				<RadioGroup class="gap-0.5">
					<Each of={MODES} key={(m) => m.mode}>
						{(m) => (
							<RadioRow
								testID={`mode-${m().mode}`}
								label={m().label}
								checked={mode() === m().mode}
								disabled={newBusy() || !chatPick()}
								onChange={() => {
									const pick = chatPick();
									if (pick && pick.mode !== m().mode) void chooseChat(chats, { ...pick, mode: m().mode });
								}}
							/>
						)}
					</Each>
				</RadioGroup>
			</View>
			<Text testID="chat-setup" class="text-xs text-muted-foreground">
				{where()}
			</Text>
			<Text class="text-xs text-faint">
				It is not a mission: Pilot asks no questions first, and the chat works on its own.
			</Text>
			<View class="flex-row gap-2">
				<Action
					primary
					label={newBusy() ? "Starting…" : "Start chat"}
					disabled={newBusy() || !ready()}
					onPress={() => void startNewChat(chats)}
				/>
				<Action label="Cancel" disabled={newBusy()} onPress={() => confirmingStart.set(false)} />
			</View>
		</View>
	);
}

/** New chats whose result is not known: Check reads the saved answer and sends nothing. */
function Unconfirmed(props: { plans: Plans }) {
	const chats = props.plans.chats;
	const view = () => chats.view();
	return (
		<Each of={view().unsettled} key={(o) => o.operationId}>
			{(o) => (
				<View testID={`chat-unknown-${o().operationId}`} class="gap-2 rounded-xl bg-muted px-4 py-3">
					<View class="flex-row items-center gap-2.5">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">
							{`A new chat in ${projectName(view(), o().projectId)} is not confirmed.`}
						</Text>
					</View>
					<Text class="text-xs leading-relaxed text-faint">
						Pilot will not send it again. Check only reads its saved answer. Another new chat waits until then.
					</Text>
					<View class="flex-row">
						<Action
							label={o().delivery === "checking" ? "Checking…" : "Check"}
							accessibilityLabel="Check whether the new chat started. This reads Pilot's saved answer and sends nothing."
							disabled={o().delivery === "checking"}
							onPress={() => void checkNewChat(chats, o().operationId)}
						/>
					</View>
				</View>
			)}
		</Each>
	);
}

/** The New screen. */
export function NewScreen(props: { plans: Plans }) {
	const planning = () => props.plans.planning();
	const chats = props.plans.chats;
	const chatView = () => chats.view();
	const off = () => !planning().canCreate;
	const chatsOff = () => chatView().availability === "unavailable";
	const empty = () => goalDraft().trim() === "";
	const canCheck = () => {
		planning();
		return props.plans.feed.canCheckNew?.() === true;
	};
	// The project the user chose, while Pilot still lists it. Null until they choose.
	const picked = () => chatView().projects.find((p) => p.projectId === chatPick()?.projectId) ?? null;
	// Legacy project-bound windows keep their scope. Profile-only windows
	// prepare planning from the user's explicit native project choice.
	const elsewhere = () => {
		const pick = picked();
		return !!pick && !!chatView().current && pick.projectId !== chatView().current;
	};
	const ownName = () => projectName(chatView(), chatView().current ?? "");
	const canPlan = () => !!picked() && !!chatChoice() && !chatSelecting() && !elsewhere();
	const canStartChat = () =>
		chatView().availability === "live" && !!picked() && chatView().unsettled.length === 0 && !chatView().creating;
	// Reopening New renews setup and reads projects: neither is execution authority or a pending send.
	effect(() => {
		untracked(() => {
			void prepareChat(chats);
		});
	});
	// A new or restored explicit choice only reads planning setup. Native code
	// checks that same choice again at Plan; no enrollment happens here.
	effect(() => {
		chatChoice();
		untracked(() => void props.plans.feed.prepareNew?.());
	});
	// Leaving New without words drops the project choice: nothing keeps it.
	// Words keep it, as their draft's project.
	cleanup(() => {
		if (goalDraft().trim() === "" && !newBusy()) dropChoice();
	});
	// New's place: its scroll, and the goal field's focus and selection.
	const scroll = keepScroll("new");
	const goal = keepField("goal", () => "new", goalDraft);
	// Escape works from the goal field too: the draft stays. An open project list closes first.
	keymap.bind(
		"escape",
		() => {
			if (projectsOpen()) return;
			if (confirmingStart()) confirmingStart.set(false);
			else closePlanning();
		},
		{ when: "always" },
	);
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<View class="gap-3">
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						What do you want done?
					</Text>
					<Text class="text-sm leading-relaxed text-muted-foreground">
						Say it in your own words. A mission starts with questions to clarify what you want.
					</Text>
					<Input
						testID="goal"
						ref={goal.ref}
						accessibilityLabel="What you want done"
						multiline
						autoFocus
						readonly={off() && chatsOff()}
						value={goalDraft()}
						onChange={({ value }) => {
							goalDraft.set(value);
							if (value.trim() === "") replacesDraft.set(null);
							confirmingStart.set(false);
						}}
						onFocus={goal.focus}
						onSelectionChange={goal.select}
						placeholder="For example: let people export a chat as Markdown"
						class="min-h-20 rounded-xl border border-input bg-background px-3.5 py-2.5 text-base text-foreground focus:border-primary"
					/>
					<ProjectRow plans={props.plans} />
					<If when={replacesDraft()}>
						<Text testID="new-replaces" class="text-xs text-faint">
							{`Re-plans “${replacesDraft()?.title ?? ""}”. That mission stays as it is.`}
						</Text>
					</If>
				</View>
				<If when={off()}>
					<View testID="planning-off" class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">
							{chatsOff()
								? `${planning().createReason} Nothing can be sent from here.`
								: `${planning().createReason} You can still start one chat.`}
						</Text>
					</View>
				</If>
				<If when={canCheck()}>
					<Action label="Check creation" disabled={newBusy()} onPress={() => void checkCreation(props.plans)} />
				</If>
				<If when={off() && !canCheck() && props.plans.feed.prepareNew}>
					<Action label="Read again" disabled={newBusy()} onPress={() => void props.plans.feed.prepareNew?.()} />
				</If>
				<Unconfirmed plans={props.plans} />
				<If when={!confirmingStart()}>
					<View class="gap-3">
						<View class="flex-row flex-wrap items-center gap-2">
							<Action
								primary
								label={newBusy() ? "Writing questions…" : "Plan a mission"}
								disabled={off() || empty() || newBusy() || !canPlan()}
								onPress={() => {
									if (canPlan()) void planMission(props.plans);
								}}
							/>
							<Action
								label="Start as one chat"
								disabled={!canStartChat() || empty() || newBusy()}
								onPress={() => {
									newMessage.set("");
									// A choice whose setup could not be read is read again: passive.
									const pick = chatPick();
									if (pick && !chatChoice() && !chatSelecting()) void chooseChat(chats, pick);
									glide();
									confirmingStart.set(true);
								}}
							/>
						</View>
						<If when={!picked()}>
							<Text testID="choose-first" class="text-xs leading-relaxed text-faint">
								Plan a mission and Start as one chat wait for a project.
							</Text>
						</If>
						<If when={elsewhere()}>
							<Text testID="mission-elsewhere" class="text-xs leading-relaxed text-muted-foreground">
								{`Missions start in ${ownName()} here. Choose ${ownName()} to plan one, or start this as one chat.`}
							</Text>
						</If>
						<If when={canPlan()}>
							<Text class="text-xs text-faint">
								{planning().canCreate ? `${planning().setup.access} · ${planning().setup.model}` : ""}
							</Text>
							<Text class="text-xs leading-relaxed text-faint">
								Answer one question at a time, or use See all. Submit only when every question is answered.
								Review and agree to the plan next; building needs a separate Start work confirmation.
							</Text>
						</If>
					</View>
				</If>
				<If when={confirmingStart()}>
					<ConfirmStart plans={props.plans} />
				</If>
				<If when={newMessage()}>
					<Text role="alert" class="text-sm text-muted-foreground">
						{newMessage()}
					</Text>
				</If>
				<If when={chatView().settled.some((o) => o.delivery === "accepted")}>
					<View class="gap-1">
						<View class="pb-2">
							<SectionTitle
								title="Started here"
								count={chatView().settled.filter((o) => o.delivery === "accepted").length}
							/>
						</View>
						<Each of={chatView().settled.filter((o) => o.delivery === "accepted")} key={(o) => o.operationId}>
							{(o) => (
								<View class="flex-row items-center gap-2.5 py-1.5">
									<Mark kind="done" />
									<Text class="flex-1 text-sm text-foreground">{`A chat in ${projectName(chatView(), o().projectId)}`}</Text>
									<Text class="text-xs text-faint">Works on its own</Text>
								</View>
							)}
						</Each>
					</View>
				</If>
				<If when={planning().plans.length > 0}>
					<View class="gap-1">
						<View class="pb-2">
							<SectionTitle title="Missions in planning" count={planning().plans.length} />
						</View>
						<Each of={planning().plans} key={(p) => p.missionId}>
							{(p) => (
								<View class="gap-1 border-t border-border py-3">
									<RowLink
										testID={`plan-${p().missionId}`}
										title={p().title}
										accessibilityLabel={`${p().title}, ${stageWord(p().stage)}. Open its planning.`}
										onPress={() => openPlan(p().missionId)}
									>
										<View class="flex-row items-center gap-1.5">
											<Mark kind={stageMark(p().stage)} />
											<Text class="text-xs text-muted-foreground">{stageWord(p().stage)}</Text>
										</View>
									</RowLink>
									<Text class="text-sm text-muted-foreground">{p().line}</Text>
								</View>
							)}
						</Each>
					</View>
				</If>
			</View>
		</Scroll>
	);
}
