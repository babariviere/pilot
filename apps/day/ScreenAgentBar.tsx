// The screen agent's bar (docs/technical/day-screen-agent.md): hidden until Command+J or the palette's
// "Ask about this window", a field at the bottom of the window, the agent's latest answer above it, and the
// whole conversation or a feedback draft on request. Point attaches one control to the next question. The
// bar itself is hidden from the agent. Esc hides it; the conversation stays with the window.
import {
	cleanup,
	computed,
	effect,
	keymap,
	type JSX,
	type MouseEvent,
	Overlay,
	type PressEvent,
	Scroll,
	type ScrollRef,
	signal,
	View,
	windowSize,
} from "nsh";
import {
	acted,
	FEEDBACK_REQUEST,
	feedbackDraft,
	openedMessage,
	type Pointed,
	pointedMessage,
	type ScreenAgentSource,
	spokenWords,
} from "./screenAgent";
import type { ScreenPicture } from "./screenAgentContract";
import { screenAgentOpen } from "./screenAgentOpen";
import type { SessionChat } from "./sessionChat";
import {
	type AgentFrame,
	AgentScope,
	Body,
	Bubble,
	Button,
	Buttons,
	Caption,
	Composer,
	type ControlFrame,
	controlAt,
	controlFrames,
	Event,
	frameOf,
	type Glance,
	glance,
	Heading,
	KeyCap,
	Link,
	Mark,
	Notice,
	Reply,
	Spacer,
	smallestAt,
	TextField,
	WorkingLine,
} from "./ui";

/** The bar's width: the composer's line and an answer of a few lines. */
const BAR_WIDTH = 600;

type Ring = { frame: AgentFrame; label: string };

// LIBRARY GAP: no part marks a control on the window with its name (the ring around what the person pointed at,
// or what the agent just used). This ring draws with theme tokens over the page until the library offers one.
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
			{/* The name goes below a control at the top of the window, where above would be cut off. */}
			<View
				class={`absolute left-0 w-max rounded-md bg-primary px-1.5 py-0.5 ${props.ring.frame.y < 28 ? "-bottom-6" : "-top-6"}`}
			>
				<Caption tone="onAccent">{props.ring.label}</Caption>
			</View>
		</View>
	);
}

/** One line of the conversation, as the chat page shows it. */
function Line(props: { row: SessionChat["rows"][number] }) {
	return (
		<View>
			<If when={props.row.role === "you"}>
				<Bubble text={spokenWords(props.row.text)} />
			</If>
			<If when={props.row.role === "pilot"}>
				<Reply>
					<Body>{props.row.text}</Body>
				</Reply>
			</If>
			<If when={props.row.role === "step" && props.row.text.includes("Needs a person")}>
				<Notice kind="needs" text={props.row.text} />
			</If>
			<If when={props.row.role === "step" && !props.row.text.includes("Needs a person")}>
				<If when={props.row.running} else={<Event text={props.row.text} />}>
					<WorkingLine text={props.row.text} />
				</If>
			</If>
		</View>
	);
}

// LIBRARY GAP: no part is a card that floats over the window (an opaque popover surface with the panel's radius,
// a hairline and a shadow). The bar's answer, conversation and feedback draft, and its composer, need one: the
// Panel sits in page flow and the Composer's soft fill shows the page through it. `small` is the pointing hint.
// `bare` only lays the opaque surface under the Composer, which draws its own frame.
function FloatingCard(props: {
	testID?: string;
	maxHeight?: number;
	small?: boolean;
	bare?: boolean;
	children?: JSX.Element;
}) {
	return (
		<View
			testID={props.testID}
			class={
				props.bare
					? "rounded-(--radius-panel) bg-popover shadow-lg"
					: `rounded-(--radius-panel) border border-border bg-popover shadow-lg ${props.small ? "flex-row items-center gap-2 px-3 py-1.5" : "gap-3 px-4 py-3.5"}`
			}
			style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}
		>
			{props.children}
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
	// While pointing: every control's frame, measured once when pointing starts, and the one under the mouse.
	const frames = signal<ControlFrame[] | null>(null);
	const hovered = signal<ControlFrame | null>(null);
	const pointed = signal<(Pointed & { frame: AgentFrame }) | null>(null);
	const view = signal<"answer" | "conversation" | "feedback">("answer");
	const draft = signal<string | null>(null);
	const asked = signal(false);
	const picture = signal<ScreenPicture | null>(null);
	const sent = signal("");
	const actedRing = signal<Ring | null>(null);

	keymap.bind("mod+j", () => screenAgentOpen.set(!screenAgentOpen()), { when: "always" });
	// What the window showed when the bar opened; the next question carries it once.
	let atOpen: Glance | null = null;
	effect(() => {
		atOpen = screenAgentOpen() ? glance() : null;
	});
	effect(() => {
		hovered.set(null);
		frames.set(null);
		if (!pointing()) return;
		void controlFrames().then((list) => {
			if (pointing()) frames.set(list);
		});
	});
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
		const said = pointedMessage(p ? { ref: p.ref, component: p.component, label: p.label } : null, words());
		const ok = await send(openedMessage(atOpen, said));
		if (ok) {
			atOpen = null;
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
	const hover = (e: MouseEvent) => {
		const list = frames();
		if (list) hovered.set(smallestAt(list, e.pagePosition.x, e.pagePosition.y));
	};
	const point = async (e: PressEvent) => {
		const list = frames();
		pointing.set(false);
		const hit = list
			? smallestAt(list, e.pagePosition.x, e.pagePosition.y)
			: await controlAt(e.pagePosition.x, e.pagePosition.y);
		pointed.set(hit ? { ref: hit.ref, component: hit.component, label: hit.label, frame: hit.frame } : null);
	};
	const left = () => Math.max(16, (windowSize().width - BAR_WIDTH) / 2);
	// The conversation opens at its newest row and follows new rows.
	let rowsScroll: ScrollRef | undefined;
	effect(() => {
		const rows = chat()?.rows.length ?? 0;
		// After layout, so the end includes the new rows.
		if (view() === "conversation" && rows > 0)
			requestAnimationFrame(() => rowsScroll?.scrollToEnd({ animated: false }));
	});

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
					<If when={pointing() && hovered()}>
						<RingMark
							ring={{
								frame: (hovered() as ControlFrame).frame,
								label: hovered()?.label ?? hovered()?.component ?? "",
							}}
						/>
					</If>
				</View>
				<If when={pointing()}>
					<Overlay testID="screen-agent-pointing" class="inset-0" onCancel={() => pointing.set(false)}>
						<View
							class="absolute inset-0"
							style={{ cursor: "crosshair" }}
							onMouseMove={hover}
							onMouseLeave={() => hovered.set(null)}
							onPress={(e: PressEvent) => void point(e)}
						/>
						<View class="absolute left-0 right-0 top-14 items-center" style={{ pointerEvents: "none" }}>
							<FloatingCard small>
								<Caption tone="default">Click what you mean</Caption>
								<KeyCap label="esc" />
							</FloatingCard>
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
						<FloatingCard maxHeight={360}>
							{/* A long answer scrolls inside the bar instead of running past it. */}
							<Scroll testID="screen-agent-answer" class="min-h-0 shrink" contentClass="gap-3">
								<Each of={latest(chat())} key={(r) => r.key}>
									{(r) => <Line row={r()} />}
								</Each>
							</Scroll>
							<If when={problem()}>
								<Notice kind="needs" text={problem()} />
							</If>
							<If when={chat()}>
								<Buttons>
									<Spacer />
									<Link
										label="Show conversation"
										testID="screen-agent-conversation"
										onPress={() => view.set("conversation")}
									/>
									<Button
										label="Make feedback"
										testID="screen-agent-feedback"
										onPress={() => void makeFeedback()}
									/>
								</Buttons>
							</If>
						</FloatingCard>
					</If>
					<If when={view() === "conversation"}>
						<FloatingCard maxHeight={360}>
							<Buttons>
								<Heading>Screen agent</Heading>
								<Spacer />
								<Button label="Make feedback" onPress={() => void makeFeedback()} />
								<Button label="Hide" testID="screen-agent-hide" onPress={() => view.set("answer")} />
							</Buttons>
							<Scroll
								testID="screen-agent-rows"
								ref={(node: ScrollRef) => (rowsScroll = node)}
								class="min-h-0 shrink"
								contentClass="gap-3"
							>
								<Each of={chat()?.rows ?? []} key={(r) => r.key}>
									{(r) => <Line row={r()} />}
								</Each>
							</Scroll>
						</FloatingCard>
					</If>
					<If when={view() === "feedback"}>
						<FloatingCard testID="screen-agent-draft">
							<Heading>Feedback</Heading>
							<If
								when={draft() !== null}
								else={
									<Body tone="muted">
										{sent() ||
											(working()
												? "The screen agent is writing it…"
												: "The screen agent did not write it. Ask again.")}
									</Body>
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
								<Caption>
									{(picture() ? "With the last picture of this window. " : "") +
										"This conversation becomes its triage."}
								</Caption>
							</If>
							<Buttons>
								<Caption tone="faint" grow>
									You send it. Nothing starts until you choose a fix.
								</Caption>
								<Button label="Back" onPress={() => view.set("answer")} />
								<Button
									label="Send feedback"
									kind="primary"
									testID="screen-agent-send-feedback"
									disabled={draft() === null || !draft()?.trim() || sending()}
									onPress={() => void sendFeedback()}
								/>
							</Buttons>
						</FloatingCard>
					</If>
					<FloatingCard bare>
						<Composer
							field={
								<TextField
									variant="composer"
									testID="screen-agent-words"
									accessibilityLabel="Ask about this window"
									placeholder="Ask about this window"
									submitBehavior="submit"
									value={words()}
									onChange={({ value }) => words.set(value)}
									onSubmit={() => void ask()}
								/>
							}
							bar={
								<>
									<Button
										label={pointing() ? "Stop pointing" : "Point at something in this window"}
										icon="pointer"
										iconOnly
										kind={pointing() ? "secondary" : "quiet"}
										testID="screen-agent-point"
										onPress={() => pointing.set(!pointing())}
									/>
									<If when={pointed()}>
										<Caption tone="default">{pointed()?.label ?? pointed()?.ref ?? ""}</Caption>
										<Button
											label="Stop pointing at it"
											kind="quiet"
											small
											iconOnly
											icon="back"
											onPress={() => pointed.set(null)}
										/>
									</If>
									<Spacer />
									<If when={working()}>
										<Mark kind="working" label="Working" />
									</If>
									<KeyCap label="⌘J" />
								</>
							}
						/>
					</FloatingCard>
				</Overlay>
			</If>
		</AgentScope.Provider>
	);
}
