// New: the user says what they want, then picks how it starts. A mission
// starts with a complete saved interview in the chosen project; build
// work needs a separate exact-plan Start. A small ask starts one chat in the
// project the user chose, after they confirm the exact words, project and
// access. Choosing a project only reads its setup: nothing starts, and no
// existing chat moves or changes what it may do. The user always chooses the
// project: New never picks one, so both starts wait for that choice.
// A linked mission draft from Feedback (linkedMission.ts) uses the same goal
// field, planning setup, allowance and Plan. Its project is the proposal's;
// New's other draft stays saved beside it until the user replaces it.
import { cleanup, effect, keymap, Scroll, Text, untracked, View } from "nsh";
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
import { openChat } from "./chatView";
import type { Day } from "./day";
import { fundingAmount } from "./FundingSettings";
import { keepRead } from "./freshness";
import { keepField, keepScroll } from "./kept";
import {
	backToFeedback,
	confirmLinkedSwitch,
	discardLinkedMission,
	linkedConfirm,
	replaceOtherDraft,
} from "./linkedMission";
import { jumpBack } from "./nav";
import { newFundingDraft } from "./modelSettingsDraft";
import { findingGoal, findingWork, restoreOtherDraft } from "./insightsWork";
import { OpenChatAction } from "./OpenChatAction";
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
	linkedMission,
	newBusy,
	newMessage,
	openPlan,
	projectsOpen,
	replacesDraft,
	requestDraft,
} from "./planView";
import {
	Action,
	Field,
	glide,
	Mark,
	Notice,
	Page,
	PageTitle,
	Panel,
	Picker,
	RadioList,
	RadioRow,
	RowLink,
	SectionTitle,
	TextField,
} from "./ui";

const MODES: { mode: ChatMode; label: string }[] = [
	{ mode: "build", label: modeWords("build") },
	{ mode: "ask", label: modeWords("ask") },
];

/** The project a new chat goes to: a list of the user's projects, and where the chosen one lives. */
/** What Plan does with the request New's words come from. A chat started instead leaves it in New. */
function fromRequest(r: { title: string; source: string } | null): string {
	if (!r) return "";
	return `From ${r.source}: “${r.title}”. Plan links the request to the mission.`;
}

/** One labelled value of a linked mission's scope. */
function Fact(props: { label: string; value: string; testID?: string }) {
	return (
		<View class="gap-0.5">
			<Text class="text-xs text-faint">{props.label}</Text>
			<Text testID={props.testID} class="text-sm text-foreground">
				{props.value}
			</Text>
		</View>
	);
}

/** A change that would drop the linked draft's edits waits here for the user's answer. */
function LinkedConfirm() {
	const c = () => linkedConfirm();
	const next = () => {
		const now = c();
		return now?.kind === "switch" ? now.next : null;
	};
	return (
		<If when={c()}>
			<Notice
				testID="linked-confirm"
				text={
					next()
						? `Switch to the suggestion from “${next()?.title ?? ""}”?`
						: "Discard your edits to this linked draft?"
				}
				detail={
					next()
						? "This linked draft has your edits. Switching drops them. Your other New draft stays saved."
						: "Your other New draft comes back. Nothing is sent."
				}
			>
				<View class="flex-row flex-wrap gap-2">
					<Action
						label={next() ? "Switch draft" : "Discard draft"}
						disabled={newBusy()}
						onPress={() => (next() ? confirmLinkedSwitch() : discardLinkedMission(true))}
					/>
					<Action label="Keep editing" onPress={() => linkedConfirm.set(null)} />
				</View>
			</Notice>
		</If>
	);
}

/** The mission allowance Plan names. Shown once, only when this service needs one. */
function MissionAllowance() {
	return (
		<View class="gap-1.5">
			<Field
				label="Mission allowance (USD catalog value)"
				testID="mission-allowance"
				placeholder="Choose an amount before planning"
				value={newFundingDraft()?.mission ?? ""}
				onChange={(text) => {
					const d = newFundingDraft();
					if (d) newFundingDraft.set({ ...d, mission: text });
				}}
			/>
			<Text class="text-xs text-faint">
				One lifetime allowance includes planning, research, helpers, reviews and retries. Nothing is free because it
				uses a subscription.
			</Text>
		</View>
	);
}

/**
 * A linked draft's scope, shown once: the proposal's project, the model
 * planning uses there and the mission allowance. Then New's other draft,
 * which stays saved unless the user chooses to replace it.
 */
function LinkedScope(props: { plans: Plans; canPlan: boolean }) {
	const chats = props.plans.chats;
	const linked = () => linkedMission();
	const setup = () => props.plans.planning().setup;
	const model = () => {
		if (chatSelecting()) return "Reading this project's setup…";
		return props.canPlan && props.plans.planning().canCreate ? setup().model : "Not known yet";
	};
	const other = () => linked()?.other ?? null;
	const otherWords = () => {
		const o = other();
		if (!o) return "";
		const words = o.goal.trim().split("\n")[0] ?? "";
		if (words) return words.length > 120 ? `${words.slice(0, 119)}…` : words;
		return o.pick ? `A project choice: ${projectName(chats.view(), o.pick.projectId)}` : "";
	};
	return (
		<View testID="linked-scope" class="gap-3">
			<View class="flex-row flex-wrap gap-x-8 gap-y-2">
				<Fact
					label="Project"
					testID="linked-project"
					value={projectName(chats.view(), linked()?.projectId ?? "")}
				/>
				<Fact label="Model" testID="linked-model" value={model()} />
			</View>
			<If when={chatNote()}>
				<Text testID="project-note" class="text-xs text-needs-ink">
					{chatNote()}
				</Text>
			</If>
			<If when={props.canPlan && setup().allowanceRequired}>
				<MissionAllowance />
			</If>
			<If when={other()}>
				<View testID="linked-other" class="gap-2 border-t border-border pt-3">
					<Text class="text-sm text-foreground">
						{linked()?.replace
							? "Your other New draft will be replaced when you plan."
							: "Your other New draft stays saved."}
					</Text>
					<View selectable>
						<Text class="text-xs text-muted-foreground">{otherWords()}</Text>
					</View>
					<View class="flex-row">
						<Action
							label={linked()?.replace ? "Keep other draft" : "Replace other draft"}
							disabled={newBusy()}
							onPress={() => replaceOtherDraft(!linked()?.replace)}
						/>
					</View>
				</View>
			</If>
		</View>
	);
}

function ProjectRow(props: { plans: Plans }) {
	const chats = props.plans.chats;
	const view = () => chats.view();
	// Pilot lists the projects again on its own while it could not, and when the window comes back.
	const projectReads = keepRead(
		() => prepareChat(chats),
		() => view().availability === "unavailable",
		() => view().availability === "live",
	);
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
					<If when={projectReads.warn()}>
						<Action label="Try now" disabled={newBusy()} onPress={() => void projectReads.now()} />
					</If>
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
	const allowance = () => newFundingDraft()?.quickFix ?? "";
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
			<Panel size="sm" selectable>
				<Text class="text-sm text-foreground">{findingGoal(goalDraft(), "fix")}</Text>
			</Panel>
			<View class="gap-1">
				<Text class="text-xs text-faint">What it may do</Text>
				<RadioList>
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
				</RadioList>
			</View>
			<Text testID="chat-setup" class="text-xs text-muted-foreground">
				{where()}
			</Text>
			<If when={choice()?.fundingRequired}>
				<Field
					label="Quick-fix allowance (USD catalog value)"
					testID="chat-allowance"
					value={allowance()}
					placeholder="Choose an amount"
					onChange={(text) => {
						const d = newFundingDraft();
						if (d) newFundingDraft.set({ ...d, quickFix: text });
						const c = choice();
						if (c) chatChoice.set({ ...c, allowanceMicros: fundingAmount(text) ?? null });
					}}
				/>
				<Text class="text-xs text-faint">
					This allowance follows the work through retries and handoffs. Reviews also keep their own limits.
					Increase it only by explicit approval.
				</Text>
			</If>
			<Text class="text-xs text-faint">
				It is not a mission: Pilot asks no questions first, and the chat works on its own.
			</Text>
			<View class="flex-row gap-2">
				<Action
					variant="primary"
					label={newBusy() ? "Starting…" : "Start chat"}
					disabled={newBusy() || !ready() || (!!choice()?.fundingRequired && fundingAmount(allowance()) == null)}
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
				<Notice
					testID={`chat-unknown-${o().operationId}`}
					text={`A new chat in ${projectName(view(), o().projectId)} is not confirmed.`}
					detail="Pilot will not send it again. Check only reads its saved answer. Another new chat waits until then."
				>
					<View class="flex-row">
						<Action
							label={o().delivery === "checking" ? "Checking…" : "Check"}
							accessibilityLabel="Check whether the new chat started. This reads Pilot's saved answer and sends nothing."
							disabled={o().delivery === "checking"}
							onPress={() => void checkNewChat(chats, o().operationId)}
						/>
					</View>
				</Notice>
			)}
		</Each>
	);
}

/** The New screen. */
export function NewScreen(props: { plans: Plans; day?: Day }) {
	const planning = () => props.plans.planning();
	effect(() => {
		const c = chatChoice(),
			setup = planning().setup;
		untracked(() => {
			if (!c) return;
			const d = newFundingDraft();
			if (!d || d.project !== c.projectId)
				newFundingDraft.set({
					project: c.projectId,
					quickFix: c.allowanceMicros == null ? "" : String(c.allowanceMicros / 1_000_000),
					mission: setup.allowanceRequired
						? setup.allowanceMicros == null
							? ""
							: String(setup.allowanceMicros / 1_000_000)
						: null,
				});
			else if (d.mission === null && setup.allowanceRequired)
				newFundingDraft.set({
					...d,
					mission: setup.allowanceMicros == null ? "" : String(setup.allowanceMicros / 1_000_000),
				});
		});
	});
	const chats = props.plans.chats;
	const chatView = () => chats.view();
	const off = () => !planning().canCreate;
	// The planning setup, read again on its own while it is missing (backoff up to a minute) and when the window comes back.
	const setupReads = keepRead(
		async () => {
			await props.plans.feed.prepareNew?.();
		},
		() => off() && !(props.plans.feed.canCheckNew?.() ?? false) && !!props.plans.feed.prepareNew,
		() => !off(),
	);
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
	const creations = () => planning().setup.creations ?? [];
	const similar = () =>
		creations().some(
			(c) =>
				c.projectId === picked()?.projectId &&
				c.goal.trim().replace(/\s+/gu, " ").toLowerCase() ===
					goalDraft().trim().replace(/\s+/gu, " ").toLowerCase(),
		);
	const canStartChat = () =>
		chatView().availability === "live" && !!picked() && chatView().unsettled.length === 0 && !chatView().creating;
	const linked = () => linkedMission();
	// Reopening New, or a linked draft coming or going, renews setup and reads projects, then selects
	// the draft's project again: neither is execution authority or a pending send.
	effect(() => {
		linked()?.proposalDigest;
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
	// Words keep it, as their draft's project. A linked draft keeps its proposal's project.
	cleanup(() => {
		if (goalDraft().trim() === "" && !newBusy() && !linkedMission()) dropChoice();
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
			else if (props.day) (jumpBack({ day: props.day, plans: props.plans })?.go ?? closePlanning)();
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
			<Page gap={8}>
				<View class="gap-3">
					<PageTitle
						title={
							linked() || findingWork()?.kind === "plan"
								? "Plan a linked mission"
								: findingWork()
									? "Start a fix"
									: "What do you want done?"
						}
					/>
					<Text
						testID={linked() ? "linked-from" : undefined}
						class="text-sm leading-relaxed text-muted-foreground"
					>
						{linked()
							? `From Feedback: “${linked()?.title ?? ""}”. Plan links the feedback to the mission. Edit the goal first.`
							: findingWork()
								? `From Insights: “${findingWork()?.title}”. The finding and its source references stay linked when you edit the goal.`
								: "Say it in your own words. A mission starts with questions to clarify what you want."}
					</Text>
					<TextField
						testID="goal"
						ref={goal.ref}
						accessibilityLabel={linked() ? "Mission goal" : "What you want done"}
						multiline
						autoFocus
						readonly={off() && chatsOff()}
						value={goalDraft()}
						onChange={({ value }) => {
							goalDraft.set(value);
							if (value.trim() === "") {
								replacesDraft.set(null);
								requestDraft.set(null);
							}
							confirmingStart.set(false);
						}}
						onFocus={goal.focus}
						onSelectionChange={goal.select}
						placeholder="For example: let people export a chat as Markdown"
						variant="composer"
						large
					/>
					<If
						when={linked()}
						else={
							<If when={findingWork()} else={<ProjectRow plans={props.plans} />}>
								<View class="gap-1">
									<Text class="text-sm text-muted-foreground">{`Project: ${projectName(chatView(), findingWork()?.projectId ?? "")}`}</Text>
									<View class="self-start">
										<Action
											label="Discard finding draft"
											disabled={newBusy()}
											onPress={() => {
												restoreOtherDraft();
												void prepareChat(chats);
											}}
										/>
									</View>
								</View>
							</If>
						}
					>
						<LinkedScope plans={props.plans} canPlan={canPlan()} />
					</If>
					<If when={requestDraft()}>
						<Text testID="new-request" class="text-xs text-faint">
							{fromRequest(requestDraft())}
						</Text>
					</If>
					<If when={requestDraft()?.source === "Linear"}>
						<Text class="text-xs text-muted-foreground">
							{requestDraft()?.manageStatus
								? "Manage status: On. Tasks in the approved plan count toward this issue. Pilot syncs progress and review only."
								: "Manage status: Off. Reference only."}
						</Text>
					</If>
					<If when={replacesDraft()}>
						<Text testID="new-replaces" class="text-xs text-faint">
							{`Re-plans “${replacesDraft()?.title ?? ""}”. That mission stays as it is.`}
						</Text>
					</If>
				</View>
				<If when={off()}>
					<Notice
						testID="planning-off"
						text={`${planning().createReason} ${chatsOff() ? "Nothing can be sent from here." : "You can still start one chat."}`}
					/>
				</If>
				<Each of={creations()} key={(c) => c.operationId}>
					{(c) => (
						<View class="gap-2 rounded-xl bg-muted px-4 py-3">
							<Text class="text-sm font-medium text-foreground">Mission creation is not confirmed</Text>
							<Text class="text-sm text-foreground">{c().goal}</Text>
							<Text class="text-xs text-muted-foreground">{`Project: ${projectName(chatView(), c().projectId)}. Check only reads its saved result. Other drafts stay available.`}</Text>
							<Action
								label="Check status"
								disabled={newBusy()}
								onPress={() => void checkCreation(props.plans, c().operationId)}
							/>
						</View>
					)}
				</Each>
				<If when={canCheck() && creations().length === 0}>
					<View class="flex-row flex-wrap gap-2">
						<Action label="Check status" disabled={newBusy()} onPress={() => void checkCreation(props.plans)} />
					</View>
				</If>
				<If when={setupReads.warn() && off() && !canCheck() && props.plans.feed.prepareNew}>
					<Action label="Try now" disabled={newBusy()} onPress={() => void setupReads.now()} />
				</If>
				<Unconfirmed plans={props.plans} />
				<LinkedConfirm />
				<If when={!confirmingStart()}>
					<View class="gap-3">
						<View class="flex-row flex-wrap items-center gap-2">
							<If when={findingWork()?.kind !== "fix"}>
								<Action
									variant="primary"
									label={
										newBusy()
											? "Writing questions…"
											: similar()
												? "Create another"
												: linked()
													? "Plan mission"
													: "Plan a mission"
									}
									disabled={off() || empty() || newBusy() || !canPlan()}
									onPress={() => {
										if (canPlan()) void planMission(props.plans, similar());
									}}
								/>
							</If>
							<If
								when={!linked()}
								else={
									<View class="flex-row flex-wrap gap-2">
										<Action label="Back to Feedback" disabled={newBusy()} onPress={backToFeedback} />
										<Action
											variant="plain"
											label="Discard linked draft"
											disabled={newBusy()}
											onPress={() => discardLinkedMission()}
										/>
									</View>
								}
							>
								<If when={findingWork()?.kind !== "plan"}>
									<Action
										label={findingWork() ? "Review fix…" : "Start as one chat"}
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
								</If>
							</If>
						</View>
						<If when={similar()}>
							<Text class="text-xs text-muted-foreground">
								A similar request may already have created a mission. Create another makes a separate request,
								not a retry. The original stays available to check.
							</Text>
						</If>
						<If when={!picked() && !linked()}>
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
							<If when={!linked()}>
								<If when={planning().setup.allowanceRequired}>
									<MissionAllowance />
								</If>
								<Text class="text-xs text-faint">
									{planning().canCreate ? `${planning().setup.access} · ${planning().setup.model}` : ""}
								</Text>
							</If>
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
								<If
									when={o().sessionId && props.day?.chat}
									else={
										<View class="flex-row items-center gap-2.5 py-1.5">
											<Mark kind="done" />
											<Text class="min-w-0 flex-1 text-sm text-foreground">{`A chat in ${projectName(chatView(), o().projectId)}`}</Text>
											<Text class="text-xs text-faint">Works on its own</Text>
										</View>
									}
								>
									<View class="flex-row items-start gap-3 py-1.5">
										<Text class="flex-1 text-sm text-foreground">{`A chat in ${projectName(chatView(), o().projectId)}`}</Text>
										<Text class="text-xs text-faint">Works on its own</Text>
										<OpenChatAction
											testID={`new-started-${o().operationId}`}
											accessibilityLabel="Open this chat, read only. Opening it sends nothing."
											onPress={() => openChat(o().sessionId ?? "", "New")}
										/>
									</View>
								</If>
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
			</Page>
		</Scroll>
	);
}
