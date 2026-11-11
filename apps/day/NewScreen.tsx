// New: the user says what they want, then picks how it starts. A mission
// starts with a complete saved interview; build work needs a separate
// exact-plan Start. A supported small ask starts one chat after the user
// confirms the exact words, project and settings.
import { effect, keymap, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { keepField, keepScroll } from "./kept";
import { glide } from "./motion";
import { stageMark, stageWord } from "./PlanScreen";
import { checkCreation, planMission, startChat } from "./planCommands";
import type { Plans } from "./planning";
import { closePlanning, confirmingStart, goalDraft, newBusy, newMessage, openPlan } from "./planView";
import { TopBar } from "./TodayScreen";
import { Action, Mark, RowLink, SectionTitle } from "./ui";

/** The confirmation of a direct start: exactly what starts, and where. */
function ConfirmStart(props: { plans: Plans; setup: string }) {
	const setup = () => props.plans.planning().setup;
	return (
		<View testID="confirm-start" class="gap-3 rounded-2xl border border-border-strong bg-card px-5 py-4">
			<Text class="text-sm font-medium text-card-foreground">Start one chat with exactly these words?</Text>
			<View selectable class="rounded-lg bg-muted px-3 py-2">
				<Text class="text-sm text-foreground">{goalDraft()}</Text>
			</View>
			<Text class="text-xs text-muted-foreground">{`${setup().project} · ${setup().model} · ${setup().access}`}</Text>
			<Text class="text-xs text-faint">
				It is not a mission: Pilot asks no questions first, and the chat works on its own.
			</Text>
			<View class="flex-row gap-2">
				<Action
					primary
					label={newBusy() ? "Starting…" : "Start chat"}
					disabled={newBusy()}
					onPress={() => void startChat(props.plans, props.setup)}
				/>
				<Action label="Cancel" disabled={newBusy()} onPress={() => confirmingStart.set(false)} />
			</View>
		</View>
	);
}

/** The New screen. */
export function NewScreen(props: { plans: Plans }) {
	const planning = () => props.plans.planning();
	const off = () => !planning().canCreate;
	const empty = () => goalDraft().trim() === "";
	const canCheck = () => {
		planning();
		return props.plans.feed.canCheckNew?.() === true;
	};
	// Reopening New renews setup, not execution authority or a pending send.
	effect(() => {
		void props.plans.feed.prepareNew?.();
	});
	// The setup the user saw when they asked to start: the start names it.
	const shownSetup = signal("");
	// New's place: its scroll, and the goal field's focus and selection.
	const scroll = keepScroll("new");
	const goal = keepField("goal", () => "new", goalDraft);
	// Escape works from the goal field too: the draft stays.
	keymap.bind(
		"escape",
		() => {
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
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-6">
				<TopBar />
				<View class="flex-row">
					<Action label="‹ Today" accessibilityLabel="Back to Today" onPress={closePlanning} />
				</View>
				<View class="gap-3">
					<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
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
						readonly={off()}
						value={goalDraft()}
						onChange={({ value }) => {
							goalDraft.set(value);
							confirmingStart.set(false);
						}}
						onFocus={goal.focus}
						onSelectionChange={goal.select}
						placeholder="For example: let people export a chat as Markdown"
						class="min-h-20 rounded-xl border border-input bg-background px-3.5 py-2.5 text-base text-foreground focus:border-primary"
					/>
					<Text class="text-xs text-faint">
						{`${planning().setup.project} · ${planning().setup.model} · ${planning().setup.access}`}
					</Text>
				</View>
				<If when={off()}>
					<View testID="planning-off" class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">{`${planning().createReason} Nothing can be sent from here.`}</Text>
					</View>
				</If>
				<If when={canCheck()}>
					<Action label="Check creation" disabled={newBusy()} onPress={() => void checkCreation(props.plans)} />
				</If>
				<If when={off() && !canCheck() && props.plans.feed.prepareNew}>
					<Action label="Read again" disabled={newBusy()} onPress={() => void props.plans.feed.prepareNew?.()} />
				</If>
				<If when={!confirmingStart()}>
					<View class="gap-3">
						<View class="flex-row flex-wrap items-center gap-2">
							<Action
								primary
								label={newBusy() ? "Writing questions…" : "Plan a mission"}
								disabled={off() || empty() || newBusy()}
								onPress={() => void planMission(props.plans)}
							/>
							<Action
								label="Start as one chat"
								disabled={off() || !planning().canStart || empty() || newBusy()}
								onPress={() => {
									shownSetup.set(planning().setup.digest);
									newMessage.set("");
									glide();
									confirmingStart.set(true);
								}}
							/>
						</View>
						<Text class="text-xs leading-relaxed text-faint">
							Answer one question at a time, or use See all. Submit only when every question is answered. Review
							and agree to the plan next; building needs a separate Start work confirmation.
						</Text>
						<If when={!planning().canStart && planning().startReason}>
							<Text class="text-xs text-muted-foreground">{planning().startReason}</Text>
						</If>
					</View>
				</If>
				<If when={confirmingStart()}>
					<ConfirmStart plans={props.plans} setup={shownSetup()} />
				</If>
				<If when={newMessage()}>
					<Text role="alert" class="text-sm text-muted-foreground">
						{newMessage()}
					</Text>
				</If>
				<If when={planning().started.length > 0}>
					<View class="gap-1">
						<View class="pb-2">
							<SectionTitle title="Started here" count={planning().started.length} />
						</View>
						<Each of={planning().started} key={(c) => c.id}>
							{(c) => (
								<View class="gap-0.5 py-1.5">
									<Text class="text-sm text-foreground">{c().text}</Text>
									<Text class="text-xs text-faint">{c().line}</Text>
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
