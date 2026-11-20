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
// A form-width page: the goal and how it starts in one section, then what
// started here, the missions in planning and the plans whose tasks exist.
// New speaks about a project's capabilities only after the user chose it and
// Pilot read its setup: before that, one hint asks for a project.
import { cleanup, effect, keymap, Scroll, signal, untracked, View } from "nsh";
import type { Day } from "../../app/day";
import { keepField, keepScroll } from "../../app/kept";
import { jumpBack } from "../../app/nav";
import { openMission } from "../../app/view";
import { findingGoal, findingWork, restoreOtherDraft } from "../../insights/insightsWork";
import {
	checkNewChat,
	chooseChat,
	dropChoice,
	modeWords,
	prepareChat,
	projectName,
	startNewChat,
} from "../../sessions/chatCommands";
import type { ChatMode } from "../../sessions/chatFeed";
import { openChat } from "../../sessions/chatView";
import { OpenChatAction } from "../../sessions/OpenChatAction";
import { fundingAmount } from "../../settings/FundingSettings";
import { newFundingDraft } from "../../settings/models/modelSettingsDraft";
import { keepRead } from "../../sources/freshness";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	Fact,
	Facts,
	Field,
	glide,
	Link,
	Notice,
	Option,
	Options,
	Page,
	PageHead,
	Panel,
	Picker,
	Question,
	Quote,
	Row,
	Rows,
	Section,
	TextField,
} from "../../ui";
import { stageMark, stageWord } from "../planning/PlanScreen";
import { checkCreation, planMission } from "../planning/planCommands";
import type { Plans } from "../planning/planning";
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
} from "../planning/planView";
import { stateMark, stateTone, stateWord } from "../words";
import {
	backToFeedback,
	confirmLinkedSwitch,
	discardLinkedMission,
	linkedConfirm,
	replaceOtherDraft,
} from "./linkedMission";

const MODES: { mode: ChatMode; label: string }[] = [
	{ mode: "build", label: modeWords("build") },
	{ mode: "ask", label: modeWords("ask") },
];

/** What Plan does with the request New's words come from. A chat started instead leaves it in New. */
function fromRequest(r: { title: string; source: string } | null): string {
	if (!r) return "";
	return `From ${r.source}: “${r.title}”. Plan links the request to the mission.`;
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
			<Question
				testID="linked-confirm"
				title={
					next()
						? `Switch to the suggestion from “${next()?.title ?? ""}”?`
						: "Discard your edits to this linked draft?"
				}
				foot={
					<>
						<Button
							label={next() ? "Switch draft" : "Discard draft"}
							disabled={newBusy()}
							onPress={() => (next() ? confirmLinkedSwitch() : discardLinkedMission(true))}
						/>
						<Button label="Keep editing" onPress={() => linkedConfirm.set(null)} />
					</>
				}
			>
				<Body tone="muted" measure>
					{next()
						? "This linked draft has your edits. Switching drops them. Your other New draft stays saved."
						: "Your other New draft comes back. Nothing is sent."}
				</Body>
			</Question>
		</If>
	);
}

/** The mission allowance Plan names. Shown once, only when this service needs one. */
function MissionAllowance() {
	return (
		<Field
			label="Mission allowance (USD catalog value)"
			testID="mission-allowance"
			placeholder="Choose an amount before planning"
			value={newFundingDraft()?.mission ?? ""}
			help="One lifetime allowance includes planning, research, helpers, reviews and retries. Nothing is free because it uses a subscription."
			onChange={(text) => {
				const d = newFundingDraft();
				if (d) newFundingDraft.set({ ...d, mission: text });
			}}
		/>
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
			<Facts>
				<Fact label="Project" testID="linked-project">
					{projectName(chats.view(), linked()?.projectId ?? "")}
				</Fact>
				<Fact label="Model" testID="linked-model">
					{model()}
				</Fact>
			</Facts>
			<If when={chatNote()}>
				<Caption testID="project-note" tone="needs">
					{chatNote()}
				</Caption>
			</If>
			<If when={props.canPlan && setup().allowanceRequired}>
				<MissionAllowance />
			</If>
			<If when={other()}>
				<View testID="linked-other" class="gap-2">
					<Body>
						{linked()?.replace
							? "Your other New draft will be replaced when you plan."
							: "Your other New draft stays saved."}
					</Body>
					<If when={otherWords()}>
						<Quote text={otherWords()} />
					</If>
					<Buttons>
						<Button
							label={linked()?.replace ? "Keep other draft" : "Replace other draft"}
							disabled={newBusy()}
							onPress={() => replaceOtherDraft(!linked()?.replace)}
						/>
					</Buttons>
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
	const where = () => chosen()?.projectPath ?? "";
	return (
		<View testID="new-project" class="gap-1.5">
			<View class="flex-row items-center gap-2.5">
				<Caption tone="faint">Project</Caption>
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
				<View selectable class="min-w-0 flex-1">
					<Caption testID="project-where" tone="faint" truncate>
						{where()}
					</Caption>
				</View>
			</View>
			<If when={view().availability === "unavailable"}>
				<Notice
					testID="projects-off"
					text={`Pilot cannot list your projects here. ${view().reason}`}
					action={
						<If when={projectReads.warn()}>
							<Link label="Try now" disabled={newBusy()} onPress={() => void projectReads.now()} />
						</If>
					}
				/>
			</If>
			<If when={chatNote()}>
				<Caption testID="project-note" tone="needs">
					{chatNote()}
				</Caption>
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
		<Question
			testID="confirm-start"
			title="Start one chat with exactly these words?"
			foot={
				<>
					<Button
						kind="primary"
						label={newBusy() ? "Starting…" : "Start chat"}
						disabled={
							newBusy() || !ready() || (!!choice()?.fundingRequired && fundingAmount(allowance()) == null)
						}
						onPress={() => void startNewChat(chats)}
					/>
					<Button label="Cancel" disabled={newBusy()} onPress={() => confirmingStart.set(false)} />
				</>
			}
		>
			<Quote text={findingGoal(goalDraft(), "fix")} />
			<View class="gap-1">
				<Caption tone="faint">What it may do</Caption>
				<Options>
					<Each of={MODES} key={(m) => m.mode}>
						{(m) => (
							<Option
								compact
								testID={`mode-${m().mode}`}
								title={m().label}
								checked={mode() === m().mode}
								disabled={newBusy() || !chatPick()}
								onChange={() => {
									const pick = chatPick();
									if (pick && pick.mode !== m().mode) void chooseChat(chats, { ...pick, mode: m().mode });
								}}
							/>
						)}
					</Each>
				</Options>
			</View>
			<Caption testID="chat-setup">{where()}</Caption>
			<If when={choice()?.fundingRequired}>
				<Field
					label="Quick-fix allowance (USD catalog value)"
					testID="chat-allowance"
					value={allowance()}
					placeholder="Choose an amount"
					help="This allowance follows the work through retries and handoffs. Reviews also keep their own limits. Increase it only by explicit approval."
					onChange={(text) => {
						const d = newFundingDraft();
						if (d) newFundingDraft.set({ ...d, quickFix: text });
						const c = choice();
						if (c) chatChoice.set({ ...c, allowanceMicros: fundingAmount(text) ?? null });
					}}
				/>
			</If>
			<Caption tone="faint">
				It is not a mission: Pilot asks no questions first, and the chat works on its own.
			</Caption>
		</Question>
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
					placement="section"
					kind="unconfirmed"
					text={`A new chat in ${projectName(view(), o().projectId)} is not confirmed.`}
					detail="Pilot will not send it again. Check only reads its saved answer. Another new chat waits until then."
					action={
						<Button
							small
							label={o().delivery === "checking" ? "Checking…" : "Check"}
							accessibilityLabel="Check whether the new chat started. This reads Pilot's saved answer and sends nothing."
							disabled={o().delivery === "checking"}
							onPress={() => void checkNewChat(chats, o().operationId)}
						/>
					}
				/>
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
	const chatsOff = () => chatView().availability === "unavailable";
	const empty = () => goalDraft().trim() === "";
	const canCheck = () => {
		planning();
		return props.plans.feed.canCheckNew?.() === true;
	};
	// The chosen project's planning setup read. New says what the project can
	// do only once this read answered for the current choice.
	const setupRead = signal<{ projectId: string; state: "reading" | "read" | "failed"; message: string } | null>(null);
	let setupOrder = 0;
	const readSetup = async (c: ReturnType<typeof chatChoice>, tries = 0): Promise<void> => {
		const order = ++setupOrder;
		const before = untracked(setupRead);
		if (!c) setupRead.set(null);
		else if (before?.projectId !== c.projectId || before.state === "failed")
			setupRead.set({ projectId: c.projectId, state: "reading", message: "" });
		let status = "accepted";
		let message = "";
		try {
			const outcome = await props.plans.feed.prepareNew?.();
			if (outcome) ({ status, message } = outcome);
		} catch (error) {
			status = "unknown";
			console.error("New: reading the project's planning setup failed", error);
		}
		// Only the newest read for the current project answers.
		if (!c || order !== setupOrder || untracked(chatChoice)?.projectId !== c.projectId) return;
		// Another read replaced this one: read once more for an answer of its own.
		if (status === "stale" && tries === 0) return readSetup(c, 1);
		setupRead.set(
			status === "accepted"
				? { projectId: c.projectId, state: "read", message: "" }
				: { projectId: c.projectId, state: "failed", message },
		);
	};
	const setupState = () => {
		const c = chatChoice(),
			s = setupRead();
		return c && s?.projectId === c.projectId && !chatSelecting() ? s.state : null;
	};
	const settled = () => setupState() === "read";
	const settledName = () => projectName(chatView(), chatChoice()?.projectId ?? "");
	// The setup, read again on its own while the read failed or planning stays
	// off for the chosen project (backoff up to a minute), and when the window comes back.
	const setupReads = keepRead(
		() => readSetup(untracked(chatChoice)),
		() =>
			setupState() === "failed" ||
			(settled() && off() && !(props.plans.feed.canCheckNew?.() ?? false) && !!props.plans.feed.prepareNew),
		() => settled() && !off(),
	);
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
		const c = chatChoice();
		untracked(() => void readSetup(c));
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
	const title = () =>
		linked() || findingWork()?.kind === "plan"
			? "Plan a linked mission"
			: findingWork()
				? "Start a fix"
				: "What do you want done?";
	const started = () => chatView().settled.filter((o) => o.delivery === "accepted");
	const inPlanning = () => planning().plans.filter((p) => p.stage !== "published");
	const published = () => planning().plans.filter((p) => p.stage === "published");
	// Today's row for a mission whose tasks exist: its state is the one Today shows.
	const missionRow = (id: string) => {
		const t = props.day?.today();
		return t ? ([...t.moving, ...t.notMoving, ...t.unreported].find((m) => m.id === id) ?? null) : null;
	};
	// The panel's one notice. Nothing is said about a project before the user
	// chose it and Pilot read its setup.
	const panelNotice = () => {
		if (off() && chatsOff())
			return { testID: "planning-off", text: `${planning().createReason} Nothing can be sent from here.` };
		if (setupState() === "failed")
			return {
				testID: "setup-unread",
				text: `Pilot could not read what ${settledName()} can do.`,
				detail: `${setupRead()?.message || "It tries again."} Nothing was sent.`,
				retry: true,
			};
		if (off() && settled())
			return {
				testID: "planning-off",
				text: `Pilot cannot plan a mission in ${settledName()}.`,
				detail: `${planning().createReason}${canStartChat() ? ` You can still start this as one chat in ${settledName()}.` : ""}`,
				retry: true,
			};
		return null;
	};
	return (
		<Scroll class="flex-1" contentOffset={scroll.contentOffset} scrollEventThrottle={100} onScroll={scroll.onScroll}>
			<Page width="form">
				<PageHead
					title={title()}
					textTestID={linked() ? "linked-from" : undefined}
					text={
						linked()
							? `From Feedback: “${linked()?.title ?? ""}”. Plan links the feedback to the mission. Edit the goal first.`
							: findingWork()
								? `From Insights: “${findingWork()?.title}”. The finding and its source references stay linked when you edit the goal.`
								: "Say it in your own words."
					}
				/>
				<Panel
					testID="new-panel"
					notice={
						<If when={panelNotice()}>
							<Notice
								testID={panelNotice()?.testID}
								placement="panel"
								text={panelNotice()?.text ?? ""}
								detail={panelNotice()?.detail}
								action={
									<If when={panelNotice()?.retry && setupReads.warn() && props.plans.feed.prepareNew}>
										<Link label="Try now" disabled={newBusy()} onPress={() => void setupReads.now()} />
									</If>
								}
							/>
						</If>
					}
				>
					<Column>
						<Section title={linked() ? "Mission goal" : "Your words"}>
							<Block gap={3}>
								<TextField
									testID="goal"
									ref={goal.ref}
									accessibilityLabel={linked() ? "Mission goal" : "What you want done"}
									multiline
									rows={5}
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
								/>
								<If
									when={linked()}
									else={
										<If when={findingWork()} else={<ProjectRow plans={props.plans} />}>
											<View class="gap-1.5">
												<Body tone="muted">{`Project: ${projectName(chatView(), findingWork()?.projectId ?? "")}`}</Body>
												<Buttons>
													<Button
														label="Discard finding draft"
														disabled={newBusy()}
														onPress={() => {
															restoreOtherDraft();
															void prepareChat(chats);
														}}
													/>
												</Buttons>
											</View>
										</If>
									}
								>
									<LinkedScope plans={props.plans} canPlan={canPlan()} />
								</If>
								<If when={requestDraft()}>
									<Caption testID="new-request" tone="faint">
										{fromRequest(requestDraft())}
									</Caption>
								</If>
								<If when={requestDraft()?.source === "Linear"}>
									<Caption>
										{requestDraft()?.manageStatus
											? "Manage status: On. Tasks in the approved plan count toward this issue. Pilot syncs progress and review only."
											: "Manage status: Off. Reference only."}
									</Caption>
								</If>
								<If when={replacesDraft()}>
									<Caption testID="new-replaces" tone="faint">
										{`Re-plans “${replacesDraft()?.title ?? ""}”. That mission stays as it is.`}
									</Caption>
								</If>
							</Block>
							<Each of={creations()} key={(c) => c.operationId}>
								{(c) => (
									<Notice
										placement="section"
										kind="unconfirmed"
										text="Mission creation is not confirmed"
										detail={`“${c().goal}”. Project: ${projectName(chatView(), c().projectId)}. Check only reads its saved result. Other drafts stay available.`}
										action={
											<Button
												small
												label="Check status"
												disabled={newBusy()}
												onPress={() => void checkCreation(props.plans, c().operationId)}
											/>
										}
									/>
								)}
							</Each>
							<Unconfirmed plans={props.plans} />
							<LinkedConfirm />
							<If when={canCheck() && creations().length === 0}>
								<Block>
									<Buttons>
										<Button
											label="Check status"
											disabled={newBusy()}
											onPress={() => void checkCreation(props.plans)}
										/>
									</Buttons>
								</Block>
							</If>
							<If when={!confirmingStart()}>
								<Block gap={3}>
									<Buttons>
										<If when={findingWork()?.kind !== "fix"}>
											<Button
												kind="primary"
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
												<>
													<Button label="Back to Feedback" disabled={newBusy()} onPress={backToFeedback} />
													<Button
														label="Discard linked draft"
														disabled={newBusy()}
														onPress={() => discardLinkedMission()}
													/>
												</>
											}
										>
											<If when={findingWork()?.kind !== "plan"}>
												<Button
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
									</Buttons>
									<If when={similar()}>
										<Caption>
											A similar request may already have created a mission. Create another makes a separate
											request, not a retry. The original stays available to check.
										</Caption>
									</If>
									<If when={!picked() && !linked()}>
										<Caption testID="choose-first" tone="faint">
											Choose a project to see what can start there.
										</Caption>
									</If>
									<If when={!!picked() && !linked() && !chatNote() && !settled() && setupState() !== "failed"}>
										<Caption testID="project-reading" tone="faint">
											Reading what this project can do…
										</Caption>
									</If>
									<If when={elsewhere()}>
										<Caption testID="mission-elsewhere">
											{`Missions start in ${ownName()} here. Choose ${ownName()} to plan one, or start this as one chat.`}
										</Caption>
									</If>
									<If when={canPlan() && settled() && !off()}>
										<If when={!linked()}>
											<If when={planning().setup.allowanceRequired}>
												<MissionAllowance />
											</If>
											<Caption tone="faint">{`${planning().setup.access} · ${planning().setup.model}`}</Caption>
										</If>
										<Caption tone="faint">
											Pilot asks you questions first. Then you review the plan. Work starts only when you
											confirm Start work.
										</Caption>
									</If>
								</Block>
							</If>
							<If when={confirmingStart()}>
								<ConfirmStart plans={props.plans} />
							</If>
							<If when={newMessage()}>
								<Block>
									<Body role="alert" tone="muted">
										{newMessage()}
									</Body>
								</Block>
							</If>
						</Section>
						<If when={started().length > 0}>
							<Section title="Started here" count={started().length}>
								<Rows>
									<Each of={started()} key={(o) => o.operationId}>
										{(o) => (
											<Row
												mark="done"
												title={`A chat in ${projectName(chatView(), o().projectId)}`}
												meta="Started. Open it to see its progress."
												trailing={
													<If when={o().sessionId && props.day?.chat}>
														<OpenChatAction
															testID={`new-started-${o().operationId}`}
															accessibilityLabel="Open this chat, read only. Opening it sends nothing."
															onPress={() => openChat(o().sessionId ?? "", "New")}
														/>
													</If>
												}
											/>
										)}
									</Each>
								</Rows>
							</Section>
						</If>
						<If when={inPlanning().length > 0}>
							<Section title="Missions in planning" count={inPlanning().length}>
								<Rows>
									<Each of={inPlanning()} key={(p) => p.missionId}>
										{(p) => (
											<Row
												testID={`plan-${p().missionId}`}
												mark={stageMark(p().stage)}
												title={p().title}
												meta={p().line}
												state={stageWord(p().stage)}
												stateTone={p().needsYou ? "needs" : "quiet"}
												accessibilityLabel={`${p().title}, ${stageWord(p().stage)}. Open its planning.`}
												onPress={() => openPlan(p().missionId)}
											/>
										)}
									</Each>
								</Rows>
							</Section>
						</If>
						<If when={published().length > 0}>
							<Section title="Tasks created" count={published().length}>
								<Rows>
									<Each of={published()} key={(p) => p.missionId}>
										{(p) => {
											// Today's state when it has the mission; else only a way to see its status.
											const m = () => missionRow(p().missionId);
											return (
												<If
													when={m()}
													else={
														<Row
															testID={`plan-${p().missionId}`}
															title={p().title}
															aside={
																<Link
																	label="View status"
																	testID={`plan-status-${p().missionId}`}
																	accessibilityLabel={`View the status of ${p().title}. Opening it starts nothing.`}
																	onPress={() => openPlan(p().missionId)}
																/>
															}
														/>
													}
												>
													{(row) => (
														<Row
															testID={`plan-${p().missionId}`}
															mark={stateMark(row())}
															title={p().title}
															meta={row().line}
															state={stateWord(row())}
															stateTone={stateTone(row())}
															accessibilityLabel={`${p().title}, ${stateWord(row())}. Open the mission.`}
															onPress={() => {
																closePlanning();
																openMission(p().missionId);
															}}
														/>
													)}
												</If>
											);
										}}
									</Each>
								</Rows>
							</Section>
						</If>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
