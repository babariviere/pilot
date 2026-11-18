// The screen agent's bar (docs/technical/day-screen-agent.md): hidden until Command+J or the palette's
// "Ask about this window", a field at the bottom of the window, the agent's latest answer above it, and the
// whole conversation or a feedback draft on request. Point attaches one control to the next question. The
// bar itself is hidden from the agent. Esc hides it; the conversation stays with the window.
import { cleanup, computed, effect, keymap, Overlay, type PressEvent, signal, Text, View, windowSize } from "nsh";
import type { ScreenPicture } from "./screenAgentContract";
import {
	acted,
	FEEDBACK_REQUEST,
	feedbackDraft,
	type Pointed,
	pointedMessage,
	type ScreenAgentSource,
} from "./screenAgent";
import { screenAgentOpen } from "./screenAgentOpen";
import type { SessionChat } from "./sessionChat";
import {
	Action,
	type AgentFrame,
	AgentScope,
	controlAt,
	frameOf,
	KeyCap,
	Mark,
	MarkLine,
	Panel,
	TextField,
} from "./ui";

/** The bar's width: the composer's line and an answer of a few lines. */
const BAR_WIDTH = 600;

type Ring = { frame: AgentFrame; label: string };

/** A ring around a control: the one the person pointed at, or the one the agent just used. */
function RingMark(props: { ring: Ring }) {
	return (
		<View
			class="absolute"
			style={{
				pointerEvents: "none",
				left: props.ring.frame.x - 4,
				top: props.ring.frame.y - 4,
				width: props.ring.frame.width + 8,
				height: props.ring.frame.height + 8,
			}}
		>
			<View class="absolute inset-0 rounded-lg border-2 border-ring bg-primary/10" />
			<View class="absolute -top-6 left-0 w-max rounded-md bg-primary px-1.5 py-0.5">
				<Text class="text-xs text-primary-foreground">{props.ring.label}</Text>
			</View>
		</View>
	);
}

/** One line of the conversation, as the chat page shows it. */
function Line(props: { row: SessionChat["rows"][number] }) {
	return (
		<View>
			<If when={props.row.role === "you"}>
				<View class="self-end rounded-xl bg-muted px-3 py-2">
					<Text class="text-sm leading-relaxed text-foreground">{props.row.text}</Text>
				</View>
			</If>
			<If when={props.row.role === "pilot"}>
				<View selectable>
					<Text class="text-sm leading-relaxed text-foreground">{props.row.text}</Text>
				</View>
			</If>
			<If when={props.row.role === "step" && props.row.text.includes("Needs a person")}>
				<MarkLine kind="needs">
					<Text class="text-sm text-foreground">{props.row.text}</Text>
				</MarkLine>
			</If>
			<If when={props.row.role === "step" && !props.row.text.includes("Needs a person")}>
				<View class="flex-row items-center gap-2">
					<If when={props.row.running}>
						<Mark kind="moving" />
					</If>
					<Text class="text-xs text-muted-foreground">{props.row.text}</Text>
				</View>
			</If>
		</View>
	);
}

/** The rows after the person's last words: the agent's steps and answer to them. */
function latest(chat: SessionChat | null) {
	const rows = chat?.rows ?? [];
	const at = rows.map((r) => r.role).lastIndexOf("you");
	return rows
		.slice(at + 1)
		.filter((r) => r.role === "pilot" || r.role === "step")
		.slice(-4);
}

export function ScreenAgentBar(props: { source: ScreenAgentSource }) {
	const chat = signal<SessionChat | null>(props.source.chat());
	cleanup(props.source.onChange((next) => chat.set(next)));
	const words = signal("");
	const problem = signal("");
	const sending = signal(false);
	const pointing = signal(false);
	const pointed = signal<(Pointed & { frame: AgentFrame }) | null>(null);
	const view = signal<"answer" | "conversation" | "feedback">("answer");
	const draft = signal<string | null>(null);
	const asked = signal(false);
	const picture = signal<ScreenPicture | null>(null);
	const sent = signal("");
	const actedRing = signal<Ring | null>(null);

	keymap.bind("mod+j", () => screenAgentOpen.set(!screenAgentOpen()), { when: "always" });
	effect(() => {
		const ref = acted();
		if (!ref) {
			actedRing.set(null);
			return;
		}
		void frameOf(ref).then((frame) => {
			if (frame && acted() === ref) actedRing.set({ frame, label: "Screen agent" });
		});
	});
	// The draft the agent wrote after Make feedback, once its answer comes.
	effect(() => {
		const text = asked() ? feedbackDraft(chat()) : null;
		if (text !== null) {
			draft.set(text);
			asked.set(false);
		}
	});

	const working = computed(() => sending() || chat()?.state === "working");
	const send = async (message: string) => {
		if (!message.trim() || sending()) return false;
		sending.set(true);
		problem.set("");
		try {
			const trouble = await props.source.ask(message);
			problem.set(trouble);
			return !trouble;
		} finally {
			sending.set(false);
		}
	};
	const ask = async () => {
		const p = pointed();
		const ok = await send(pointedMessage(p ? { ref: p.ref, component: p.component, label: p.label } : null, words()));
		if (ok) {
			words.set("");
			pointed.set(null);
		}
	};
	const makeFeedback = async () => {
		view.set("feedback");
		sent.set("");
		draft.set(null);
		void props.source.picture().then((p) => picture.set(p));
		if (await send(FEEDBACK_REQUEST)) asked.set(true);
	};
	const sendFeedback = async () => {
		const text = draft();
		if (!text?.trim() || sending()) return;
		sending.set(true);
		try {
			const result = await props.source.sendFeedback(text.trim(), picture());
			sent.set(result.message);
			if (result.ok) draft.set(null);
		} finally {
			sending.set(false);
		}
	};
	const point = async (e: PressEvent) => {
		pointing.set(false);
		const hit = await controlAt(e.pagePosition.x, e.pagePosition.y);
		pointed.set(hit ? { ref: hit.ref, component: hit.component, label: hit.label, frame: hit.frame } : null);
	};
	const left = () => Math.max(16, (windowSize().width - BAR_WIDTH) / 2);

	return (
		<AgentScope.Provider value={{ hidden: true }}>
			<If when={screenAgentOpen()}>
				<View class="absolute inset-0" style={{ pointerEvents: "none" }}>
					<If when={pointed()}>
						<RingMark
							ring={{
								frame: (pointed() as { frame: AgentFrame }).frame,
								label: pointed()?.label ?? "You pointed",
							}}
						/>
					</If>
					<If when={actedRing()}>
						<RingMark ring={actedRing() as Ring} />
					</If>
				</View>
				<If when={pointing()}>
					<Overlay testID="screen-agent-pointing" class="inset-0" onCancel={() => pointing.set(false)}>
						<View class="absolute inset-0" onPress={(e: PressEvent) => void point(e)} />
						<View class="absolute left-0 right-0 top-14 items-center" style={{ pointerEvents: "none" }}>
							<View class="flex-row items-center gap-2 rounded-full bg-foreground px-3 py-1.5">
								<Text class="text-xs text-background">Click what you mean</Text>
								<KeyCap label="esc" />
							</View>
						</View>
					</Overlay>
				</If>
				<Overlay
					testID="screen-agent"
					class="bottom-6 gap-2"
					style={{ left: left(), width: Math.min(BAR_WIDTH, windowSize().width - 32) }}
					onCancel={() => screenAgentOpen.set(false)}
				>
					<If when={view() === "answer" && (latest(chat()).length > 0 || problem())}>
						<Panel tone="card" size="lg" class="gap-3 shadow-lg">
							<Each of={latest(chat())} key={(r) => r.key}>
								{(r) => <Line row={r()} />}
							</Each>
							<If when={problem()}>
								<MarkLine kind="unknown">
									<Text class="text-sm text-foreground">{problem()}</Text>
								</MarkLine>
							</If>
							<If when={chat()}>
								<View class="flex-row items-center gap-2">
									<View class="flex-1" />
									<Action
										label="Show conversation"
										testID="screen-agent-conversation"
										onPress={() => view.set("conversation")}
									/>
									<Action
										label="Make feedback"
										variant="outline"
										testID="screen-agent-feedback"
										onPress={() => void makeFeedback()}
									/>
								</View>
							</If>
						</Panel>
					</If>
					<If when={view() === "conversation"}>
						<Panel tone="card" size="lg" class="max-h-[360px] gap-3 shadow-lg">
							<View class="flex-row items-center gap-2">
								<Text class="flex-1 text-sm font-semibold text-foreground">Screen agent</Text>
								<Action label="Make feedback" variant="outline" onPress={() => void makeFeedback()} />
								<Action label="Hide" testID="screen-agent-hide" onPress={() => view.set("answer")} />
							</View>
							<View class="min-h-0 shrink">
								<Each of={chat()?.rows ?? []} key={(r) => r.key}>
									{(r) => <Line row={r()} />}
								</Each>
							</View>
						</Panel>
					</If>
					<If when={view() === "feedback"}>
						<Panel tone="card" size="lg" class="gap-3 shadow-lg" testID="screen-agent-draft">
							<Text class="text-sm font-semibold text-foreground">Feedback</Text>
							<If
								when={draft() !== null}
								else={
									<Text class="text-sm text-muted-foreground">
										{sent() ||
											(working()
												? "The screen agent is writing it…"
												: "The screen agent did not write it. Ask again.")}
									</Text>
								}
							>
								<TextField
									multiline
									rows={4}
									accessibilityLabel="Feedback"
									testID="screen-agent-draft-text"
									value={draft() ?? ""}
									onChange={({ value }) => draft.set(value)}
								/>
								<Text class="text-xs text-muted-foreground">
									{(picture() ? "With the last picture of this window. " : "") +
										"This conversation becomes its triage."}
								</Text>
							</If>
							<View class="flex-row items-center gap-2">
								<Text class="flex-1 text-xs text-faint">
									You send it. Nothing starts until you choose a fix.
								</Text>
								<Action label="Back" onPress={() => view.set("answer")} />
								<Action
									label="Send feedback"
									variant="primary"
									testID="screen-agent-send-feedback"
									disabled={draft() === null || !draft()?.trim() || sending()}
									onPress={() => void sendFeedback()}
								/>
							</View>
						</Panel>
					</If>
					<View class="flex-row items-center gap-2 rounded-2xl border border-border-strong bg-background px-2 py-2 shadow-lg">
						<Mark kind={working() ? "moving" : "still"} />
						<Action
							label={pointing() ? "Pointing…" : "Point"}
							testID="screen-agent-point"
							onPress={() => pointing.set(!pointing())}
						/>
						<If when={pointed()}>
							<View class="flex-row items-center gap-1 rounded-md bg-selection px-2 py-1">
								<Text class="text-xs text-foreground">{pointed()?.label ?? pointed()?.ref ?? ""}</Text>
								<Action label="Stop pointing at it" iconOnly icon="back" onPress={() => pointed.set(null)} />
							</View>
						</If>
						<TextField
							compact
							class="flex-1"
							testID="screen-agent-words"
							accessibilityLabel="Ask about this window"
							placeholder="Ask about this window"
							submitBehavior="submit"
							value={words()}
							onChange={({ value }) => words.set(value)}
							onSubmit={() => void ask()}
						/>
						<KeyCap label="⌘J" />
					</View>
				</Overlay>
			</If>
		</AgentScope.Provider>
	);
}
