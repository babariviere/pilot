// Feedback: the user's own words about Pilot, sent to Pilot's service and
// kept there. Not agent Insights or findings, and not an inbox: sending
// feedback starts no work, creates no mission and approves nothing.
// The page holds one draft with the context the user kept (Pilot in general,
// or the exact mission it was opened from). Send sends it once; only an
// accepted receipt clears it. A Send whose answer was lost stays Unknown:
// Check only reads its result. Leaving, closing or updating keeps the draft.
import { effect, type JSX, keymap, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Day } from "./day";
import {
	type FeedbackItem,
	type FeedbackMirror,
	type FeedbackView,
	MAX_FEEDBACK_BYTES,
	type UserFeedbackOriginRef,
	utf8Bytes,
} from "./feedbackFeed";
import { closeFeedback, dayOf, feedbackDraft, feedbackMessage, feedbackOffer, originKey } from "./feedbackView";
import { keepField, keepScroll } from "./kept";
import { glide } from "./motion";
import { Action, Mark, SectionTitle } from "./ui";

const SEND_KEYS = keymap.label("mod+enter");

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

/** What an origin the user can pick is called on this page. */
function originName(day: Day, origin: UserFeedbackOriginRef | null): string {
	if (!origin) return "Pilot in general";
	if (origin.kind === "mission") {
		const title = day.feed.mission(origin.missionId)?.row.title;
		return title ? `“${title}”` : "This mission";
	}
	return "This chat";
}

/** Where saved feedback came from, in a few words. */
function savedLine(item: FeedbackItem): string {
	const when = dayOf(item.recordedAt);
	const about = item.origin
		? item.origin.title
			? `About “${item.origin.title}”`
			: item.origin.kind === "mission"
				? "About a mission"
				: "About a chat"
		: "Pilot in general";
	return ["Saved", when, about].filter(Boolean).join(" · ");
}

/** The draft: what it is about, the words, and one explicit Send. */
function Compose(props: { day: Day; mirror: FeedbackMirror }) {
	const v = (): FeedbackView => props.mirror.view();
	const d = () => feedbackDraft();
	const tooLong = () => utf8Bytes(d().text) > MAX_FEEDBACK_BYTES;
	/** Why Send cannot send the draft now, or "". */
	const blocker = () => {
		if (d().text.trim() === "") return "";
		if (v().unsettled.length > 0) return "Check your earlier feedback first. Your text stays.";
		if (tooLong()) return `Too long. Keep it under ${MAX_FEEDBACK_BYTES} bytes.`;
		return "";
	};
	const canSend = () => d().text.trim() !== "" && !v().sending && blocker() === "";
	const edit = (text: string) => {
		feedbackMessage.set("");
		feedbackDraft.set({ ...feedbackDraft(), text });
	};
	const setOrigin = (origin: UserFeedbackOriginRef | null) => {
		glide();
		feedbackOffer.set(null);
		feedbackDraft.set({ ...feedbackDraft(), origin });
	};
	const send = async () => {
		const draft = feedbackDraft();
		if (!canSend()) return;
		feedbackMessage.set("");
		const r = await props.mirror.source.send({ text: draft.text, origin: draft.origin });
		// Only an accepted receipt clears the words, and only the words that were sent.
		if (r.status === "accepted" && feedbackDraft() === draft) {
			glide();
			feedbackDraft.set({ text: "", origin: draft.origin });
		}
		// An Unknown Send shows as its own note, with Check.
		feedbackMessage.set(r.status === "unknown" && v().unsettled.length > 0 ? "" : r.message);
	};
	const check = async (operationId: string) => {
		feedbackMessage.set("");
		const r = await props.mirror.source.check(operationId);
		if (r.status === "accepted" && r.saved && feedbackDraft().text === r.saved.text) {
			glide();
			feedbackDraft.set({ text: "", origin: feedbackDraft().origin });
		}
		feedbackMessage.set(r.status === "accepted" ? "Your feedback was saved." : r.message);
		void props.mirror.source.read();
	};
	keymap.bind(
		"mod+enter",
		() => {
			if (canSend()) void send();
		},
		{ when: "always" },
	);
	const field = keepField(
		"feedback-text",
		() => "feedback",
		() => feedbackDraft().text,
	);
	return (
		<View testID="feedback-compose" class="gap-4">
			<View class="flex-row items-baseline gap-3 border-t border-border pt-3">
				<Text class="text-sm text-muted-foreground">About</Text>
				<Text testID="feedback-about" class="flex-1 text-sm font-medium text-foreground">
					{originName(props.day, d().origin)}
				</Text>
				<If when={d().origin}>
					<Action
						label="Make it general"
						testID="feedback-general"
						accessibilityLabel="Send this as feedback about Pilot in general. Nothing is sent now."
						onPress={() => setOrigin(null)}
					/>
				</If>
			</View>
			<Each
				of={feedbackOffer() ? [feedbackOffer() as { origin: UserFeedbackOriginRef | null }] : []}
				key={(o) => originKey(o.origin)}
			>
				{(o) => (
					<Note
						testID="feedback-offer"
						text={`Your unsent feedback is about ${originName(props.day, d().origin)}.`}
						detail={`You opened this page from ${originName(props.day, o().origin)}. Your words keep their context unless you change it.`}
					>
						<View class="flex-row gap-2">
							<Action
								label={o().origin ? "Use this one instead" : "Make it general"}
								testID="feedback-offer-use"
								onPress={() => setOrigin(o().origin)}
							/>
							<Action label="Keep it" testID="feedback-offer-keep" onPress={() => feedbackOffer.set(null)} />
						</View>
					</Note>
				)}
			</Each>
			<Input
				testID="feedback-text"
				ref={field.ref}
				multiline
				autoFocus
				readonly={v().sending}
				value={d().text}
				accessibilityLabel="Your feedback about Pilot"
				placeholder="What happened, and what would make it better?"
				onChange={({ value }) => edit(value)}
				onFocus={field.focus}
				onSelectionChange={field.select}
				class="min-h-28 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary"
			/>
			<If when={blocker()}>
				<Text testID="feedback-blocked" class="text-xs text-needs-ink">
					{blocker()}
				</Text>
			</If>
			<Each of={v().unsettled} key={(o) => o.operationId}>
				{(o) => (
					<Note
						testID="feedback-unknown"
						text="Pilot does not know if your last feedback was saved."
						detail="It will not send it again. Check only reads its result. Your text stays here."
					>
						<View class="flex-row">
							<Action
								label={o().state === "checking" ? "Checking…" : "Check"}
								testID="feedback-check"
								disabled={o().state === "checking"}
								onPress={() => void check(o().operationId)}
							/>
						</View>
					</Note>
				)}
			</Each>
			<View class="flex-row items-center gap-3">
				<Action
					primary
					label={v().sending ? "Sending…" : "Send"}
					shortcut={SEND_KEYS}
					testID="feedback-send"
					disabled={!canSend()}
					onPress={() => void send()}
				/>
				<If when={feedbackMessage()}>
					<Text testID="feedback-message" class="flex-1 text-xs text-muted-foreground">
						{feedbackMessage()}
					</Text>
				</If>
			</View>
		</View>
	);
}

/** Saved feedback, newest first. Reading it changes nothing. */
function Sent(props: { mirror: FeedbackMirror }) {
	const v = (): FeedbackView => props.mirror.view();
	const loading = signal(false);
	const more = async () => {
		loading.set(true);
		await props.mirror.source.more();
		loading.set(false);
	};
	return (
		<View testID="feedback-sent" class="gap-3">
			<View class="gap-1.5">
				<SectionTitle title="Sent" count={v().items.length} />
				<Text class="text-sm leading-relaxed text-muted-foreground">
					Pilot keeps your feedback here, in your words. Nothing triages or routes it yet, and it never starts work
					on its own.
				</Text>
			</View>
			<If when={v().reason}>
				<Note
					testID="feedback-off"
					text={v().availability === "live" ? v().reason : `Pilot cannot show your feedback. ${v().reason}`}
					detail={v().availability === "live" ? undefined : "This is not the same as having none."}
				/>
			</If>
			<If when={v().availability === "reading" && v().items.length === 0}>
				<Text class="text-sm text-muted-foreground">Reading your feedback…</Text>
			</If>
			<If when={v().availability === "live" && v().items.length === 0}>
				<Text testID="feedback-empty" class="border-t border-border py-3.5 text-sm text-muted-foreground">
					No feedback sent yet.
				</Text>
			</If>
			<View>
				<Each of={v().items} key={(i) => i.id}>
					{(i) => (
						<View testID={`feedback-item-${i().id}`} class="gap-1 border-t border-border py-3">
							<Text class="text-sm leading-relaxed text-foreground">{i().text}</Text>
							<Text class="text-xs text-faint">{savedLine(i())}</Text>
						</View>
					)}
				</Each>
			</View>
			<If when={v().more}>
				<View class="flex-row">
					<Action
						label={loading() ? "Reading…" : "Show earlier"}
						testID="feedback-more"
						disabled={loading()}
						onPress={() => void more()}
					/>
				</View>
			</If>
		</View>
	);
}

/** The feedback page. Opening it only reads. */
export function FeedbackScreen(props: { day: Day }) {
	const mirror = props.day.feedback as FeedbackMirror;
	void mirror.source.read();
	keymap.bind("escape", closeFeedback, { when: "always" });
	const scroll = keepScroll("feedback");
	// A restored offset waits for the rows it scrolled through.
	let waiting = scroll.contentOffset.y > 0 ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const node = scroller();
		if (waiting === null || !node || mirror.view().availability !== "live") return;
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
			<View testID="feedback" class="w-full max-w-2xl self-center gap-10 px-6 pb-24 pt-10">
				<View class="gap-3">
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						Feedback
					</Text>
					<Text class="text-base leading-relaxed text-muted-foreground">
						Tell Pilot what works and what gets in your way. Your words are saved with the context you choose.
						Sending feedback starts no work and approves nothing.
					</Text>
				</View>
				<Compose day={props.day} mirror={mirror} />
				<Sent mirror={mirror} />
			</View>
		</Scroll>
	);
}
