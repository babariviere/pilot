// Feedback: the user's own words about Pilot, sent to Pilot's service and
// kept there. Not agent Insights or findings, and not an inbox: sending
// feedback creates no mission and approves nothing. When the user chose a
// project for agents, a saved Send also starts a read-only triage there; its
// proposal starts nothing until the user presses one of its commands.
// The page holds one draft with the context the user kept (Pilot in general,
// or the exact mission it was opened from). Send sends it once; only an
// accepted receipt clears it. A Send whose answer was lost stays Unknown:
// Check only reads its result. Leaving, closing or updating keeps the draft.
import { effect, keymap, Scroll, type ScrollRef, signal, View } from "nsh";
import { namedFeedbackPaths } from "../../packages/kernel/src/feedback-paths";
import type { Day } from "./day";
import { clearFeedbackImagePreviews, FeedbackImages } from "./FeedbackImages";
import { FeedbackListRow } from "./FeedbackRow";
import {
	type FeedbackItem,
	type FeedbackMirror,
	type FeedbackView,
	MAX_FEEDBACK_BYTES,
	sameFeedback,
	type UserFeedbackOriginRef,
	utf8Bytes,
} from "./feedbackFeed";
import { askingOf, stepsOf } from "./feedbackSteps";
import {
	closeFeedback,
	dayOf,
	feedbackDraft,
	feedbackDraftKey,
	feedbackImageBusy,
	feedbackImagePending,
	feedbackKeptDrafts,
	feedbackMessage,
	feedbackOffer,
	feedbackProject,
	feedbackSearch,
	forgetKeptFeedback,
	keepFeedbackDraft,
	originKey,
	resumeFeedbackDraft,
	setStepMessage,
} from "./feedbackView";
import { keepRead, staleLine } from "./freshness";
import { keepField, keepScroll } from "./kept";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Column,
	EmptyLine,
	glide,
	Link,
	Notice,
	Page,
	PageHead,
	Panel,
	Picker,
	Rows,
	Section,
	TextField,
} from "./ui";

const SEND_KEYS = keymap.label("mod+enter");

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

/** The project agents triage and fix feedback in. Nothing is chosen for the user. */
function AgentProject(props: { mirror: FeedbackMirror }) {
	const v = (): FeedbackView => props.mirror.view();
	const projects = () => v().projects ?? [];
	const chosen = () => projects().find((p) => p.projectId === feedbackProject()) ?? null;
	return (
		<View testID="feedback-agents" class="gap-1">
			<View class="flex-row items-center gap-2.5">
				<Caption tone="faint">Agent triage in</Caption>
				<Picker
					testID="feedback-project"
					label="Project where agents triage and fix your feedback"
					items={projects().map((p) => ({ value: p.projectId, title: p.name }))}
					value={chosen()?.projectId ?? null}
					placeholder={v().projects ? "Choose a project" : "Reading projects…"}
					disabled={projects().length === 0}
					searchable={projects().length > 8}
					searchPlaceholder="Find a project"
					onChange={(id) => {
						glide();
						feedbackProject.set(id);
					}}
				/>
				<If when={chosen()}>
					<Link label="No triage" testID="feedback-project-none" onPress={() => feedbackProject.set(null)} />
				</If>
			</View>
			{/* Two notes, not one whose words change: a note that grows from one line to two kept its old height. */}
			<If
				when={chosen()}
				else={
					<Caption testID="feedback-agents-note" tone="faint">
						Choose the project with Pilot's code to have an agent triage what you send.
					</Caption>
				}
			>
				<Caption testID="feedback-agents-note" tone="faint">
					A read-only agent reads that project and proposes what to do. It changes nothing; you pick the next step.
				</Caption>
			</If>
		</View>
	);
}

/** The draft: what it is about, the words, and one explicit Send. */
function Compose(props: { day: Day; mirror: FeedbackMirror }) {
	const v = (): FeedbackView => props.mirror.view();
	const d = () => feedbackDraft();
	const tooLong = () => utf8Bytes(d().text) > MAX_FEEDBACK_BYTES;
	/** Why Send cannot send the draft now, or "". */
	const blocker = () => {
		if (d().text.trim() === "") return "";
		if (v().unsettled.some((o) => sameFeedback(o, d())))
			return "Check this feedback first, or write another item. Your text stays.";
		if (feedbackImageBusy() || feedbackImagePending())
			return "Finish attaching your image, or remove it before sending.";
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
		const project = v().projects?.find((p) => p.projectId === feedbackProject());
		feedbackMessage.set("");
		const r = await props.mirror.source.send({
			text: draft.text,
			origin: draft.origin,
			...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
			...(project ? { investigation: { projectId: project.projectId, contextDigest: project.contextDigest } } : {}),
		});
		if (r.status === "accepted") forgetKeptFeedback(draft);
		// Only an accepted receipt clears the words, and only the words that were sent.
		if (r.status === "accepted" && feedbackDraft() === draft) {
			glide();
			feedbackDraft.set({ text: "", origin: draft.origin });
			clearFeedbackImagePreviews();
		}
		// An Unknown Send shows as its own note, with Check.
		feedbackMessage.set(r.status === "unknown" && v().unsettled.length > 0 ? "" : r.message);
		if (r.saved && r.investigation && r.investigation.status !== "accepted")
			setStepMessage(r.saved.id, `Saved. Investigation: ${r.investigation.message}`);
		// The user chose a project for agents: the saved feedback's triage starts there, once.
		if (r.status === "accepted" && r.saved && project && !r.saved.investigation) {
			const t = await props.mirror.source.step({
				action: "triage",
				feedbackId: r.saved.id,
				projectId: project.projectId,
				contextDigest: project.contextDigest,
			});
			if (t.status !== "accepted" && t.status !== "unknown")
				setStepMessage(r.saved.id, `Saved, but its triage did not start. ${t.message}`);
		}
	};
	const check = async (operationId: string) => {
		const original = v().unsettled.find((o) => o.operationId === operationId);
		// Capture before I/O: a rejected or lost Check must not strand these words,
		// even if the user navigates or edits the active draft while it runs.
		if (original)
			keepFeedbackDraft({ text: original.text, origin: original.origin, attachments: original.attachments ?? [] });
		feedbackMessage.set("");
		const r = await props.mirror.source.check(operationId);
		if (r.status === "accepted" && r.saved) forgetKeptFeedback(r.saved);
		if (r.status === "accepted" && r.saved && feedbackDraftKey(feedbackDraft()) === feedbackDraftKey(r.saved)) {
			glide();
			feedbackDraft.set({ text: "", origin: feedbackDraft().origin });
			clearFeedbackImagePreviews();
		}
		feedbackMessage.set(r.status === "accepted" ? "Your feedback was saved." : r.message);
		if (r.saved && r.investigation && r.investigation.status !== "accepted")
			setStepMessage(r.saved.id, `Saved. Investigation: ${r.investigation.message}`);
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
		<Section title="Write feedback" testID="feedback-compose">
			<Block gap={3}>
				<Buttons>
					<Caption>About</Caption>
					<BodyStrong testID="feedback-about" grow>
						{originName(props.day, d().origin)}
					</BodyStrong>
					<If when={d().origin}>
						<Link
							label="Make it general"
							testID="feedback-general"
							accessibilityLabel="Send this as feedback about Pilot in general. Nothing is sent now."
							onPress={() => setOrigin(null)}
						/>
					</If>
				</Buttons>
				<Each
					of={feedbackOffer() ? [feedbackOffer() as { origin: UserFeedbackOriginRef | null }] : []}
					key={(o) => originKey(o.origin)}
				>
					{(o) => (
						// LIBRARY GAP: Notice takes one way out, and this choice has two (use the context the page was
						// opened from, or keep the draft's). Both are Links in Notice's action slot until it offers a pair.
						<Notice
							testID="feedback-offer"
							text={`Your unsent feedback is about ${originName(props.day, d().origin)}.`}
							detail={`You opened this page from ${originName(props.day, o().origin)}. Your words keep their context unless you change it.`}
							action={
								<>
									<Link
										label={o().origin ? "Use this one instead" : "Make it general"}
										testID="feedback-offer-use"
										onPress={() => setOrigin(o().origin)}
									/>
									<Link label="Keep it" testID="feedback-offer-keep" onPress={() => feedbackOffer.set(null)} />
								</>
							}
						/>
					)}
				</Each>
				<FeedbackImages
					disabled={v().sending || v().unsettled.some((o) => sameFeedback(o, d()))}
					protectedUploads={v().unsettled.flatMap((o) => (o.attachments ?? []).map((a) => a.uploadId))}
				>
					{(onPaste) => (
						<TextField
							testID="feedback-text"
							ref={field.ref}
							multiline
							autoFocus
							readonly={v().sending}
							value={d().text}
							accessibilityLabel="Your feedback about Pilot"
							placeholder="What happened, and what would make it better?"
							onChange={({ value }) => edit(value)}
							onPaste={onPaste}
							onFocus={field.focus}
							onSelectionChange={field.select}
							rows={5}
						/>
					)}
				</FeedbackImages>
				<AgentProject mirror={props.mirror} />
				<If when={namedFeedbackPaths(d().text).length > 0}>
					<View class="gap-1" testID="feedback-named-paths">
						<Caption>Read access for this investigation</Caption>
						<Each of={namedFeedbackPaths(d().text)} key={(path) => path}>
							{(path) => <Body>{path()}</Body>}
						</Each>
						<Caption tone="faint">
							Sending includes read-only access to these named files or folders and their subfolders, if
							available. No unrelated files. Whole-home, filesystem root and repository metadata access are
							excluded. Put paths with spaces in quotes or backticks.
						</Caption>
					</View>
				</If>
				<If when={blocker()}>
					<Caption testID="feedback-blocked" tone="needs">
						{blocker()}
					</Caption>
				</If>
				<Each of={v().unsettled} key={(o) => o.operationId}>
					{(o) => (
						// LIBRARY GAP: Notice takes one way out. A lost Send offers Check and, for the draft on screen,
						// Write another; both are Links in Notice's action slot until it offers a pair.
						<Notice
							testID="feedback-unknown"
							text={o().text}
							detail="Save not confirmed. Check only reads this item's result. Other feedback can still be sent."
							action={
								<>
									<Link
										label={o().state === "checking" ? "Checking…" : "Check"}
										testID="feedback-check"
										disabled={o().state === "checking"}
										onPress={() => void check(o().operationId)}
									/>
									<If when={sameFeedback(o(), d())}>
										<Link
											label="Write another"
											testID="feedback-another"
											disabled={v().sending || feedbackImageBusy() || feedbackImagePending()}
											onPress={() => {
												keepFeedbackDraft(d());
												feedbackDraft.set({ text: "", origin: d().origin });
												clearFeedbackImagePreviews();
											}}
										/>
									</If>
								</>
							}
						/>
					)}
				</Each>
				<Each of={feedbackKeptDrafts()} key={feedbackDraftKey}>
					{(kept) => (
						<Notice
							testID="feedback-kept"
							text={kept().text}
							detail="Kept draft. Resume keeps your current words too. Images already saved with another item must be attached again."
							action={
								<Link
									label="Resume draft"
									testID="feedback-resume"
									disabled={v().sending || feedbackImageBusy() || feedbackImagePending()}
									onPress={() => {
										resumeFeedbackDraft(kept());
										clearFeedbackImagePreviews();
									}}
								/>
							}
						/>
					)}
				</Each>
				<Buttons>
					<Button
						kind="primary"
						label={v().sending ? "Sending…" : "Send"}
						shortcut={SEND_KEYS}
						testID="feedback-send"
						disabled={!canSend()}
						onPress={() => void send()}
					/>
					<If when={feedbackMessage()}>
						<Caption testID="feedback-message" grow>
							{feedbackMessage()}
						</Caption>
					</If>
				</Buttons>
			</Block>
		</Section>
	);
}

/** Saved feedback, newest first, with each item's steps. Reading it changes nothing. */
function Sent(props: { day: Day; mirror: FeedbackMirror }) {
	const v = (): FeedbackView => props.mirror.view();
	// Pilot reads again on its own after a failed read, and when the window comes back.
	const reads = keepRead(
		() => props.mirror.source.read(),
		() => !!v().reason,
		() => v().availability === "live",
	);
	const items = () => {
		const query = feedbackSearch().trim().toLocaleLowerCase();
		return v()
			.items.filter((i) => `${i.text}\n${i.origin?.title ?? ""}`.toLocaleLowerCase().includes(query))
			.sort((a, b) => Number(stepsOf(a).resolved) - Number(stepsOf(b).resolved));
	};
	const loading = signal(false);
	const more = async () => {
		loading.set(true);
		await props.mirror.source.more();
		loading.set(false);
	};
	return (
		<Section title="Sent" count={v().items.length} testID="feedback-sent">
			<Block gap={3}>
				<Caption>
					Pilot keeps your feedback here, in your words. A fix or a mission link starts only when you press it, and
					only you mark feedback resolved.
				</Caption>
				<TextField
					testID="feedback-search"
					value={feedbackSearch()}
					accessibilityLabel="Search feedback history"
					placeholder="Search feedback history"
					onChange={({ value }) => feedbackSearch.set(value)}
				/>
				<Caption tone="faint">
					{v().more
						? "Open items first. Search covers loaded feedback; Show earlier searches older items."
						: "Open items first, then resolved history."}
				</Caption>
			</Block>
			<If when={v().reason && (v().availability !== "live" || reads.stale())}>
				<Notice
					testID="feedback-off"
					placement="section"
					text={
						v().availability === "live"
							? staleLine(reads.readAt() ?? 0)
							: `Pilot cannot show your feedback. ${v().reason}`
					}
					detail={v().availability === "live" ? undefined : "This is not the same as having none."}
				/>
			</If>
			<If when={v().availability === "reading" && v().items.length === 0}>
				<EmptyLine text="Reading your feedback…" />
			</If>
			<If when={v().availability === "live" && v().items.length === 0}>
				<EmptyLine testID="feedback-empty" text="No feedback sent yet." />
			</If>
			<If when={v().availability === "live" && v().items.length > 0 && items().length === 0}>
				<EmptyLine
					testID="feedback-no-matches"
					text="No matches in loaded feedback. Change your search or read earlier items."
				/>
			</If>
			<Rows>
				<Each of={items()} key={(i) => i.id}>
					{(i) => (
						<FeedbackListRow
							day={props.day}
							mirror={props.mirror}
							item={i()}
							when={savedLine(i())}
							keyboardActive={items().find((item) => askingOf(stepsOf(item)))?.id === i().id}
						/>
					)}
				</Each>
			</Rows>
			<If when={v().more}>
				<Block>
					<View class="flex-row">
						<Link
							label={loading() ? "Reading…" : "Show earlier"}
							testID="feedback-more"
							disabled={loading()}
							onPress={() => void more()}
						/>
					</View>
				</Block>
			</If>
		</Section>
	);
}

/** The feedback page. Opening it only reads. */
export function FeedbackScreen(props: { day: Day; onBackFromJump?: () => boolean }) {
	const mirror = props.day.feedback as FeedbackMirror;
	void mirror.source.read();
	void mirror.source.readProjects();
	keymap.bind(
		"escape",
		() => {
			if (!props.onBackFromJump?.()) closeFeedback();
		},
		{ when: "always" },
	);
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
			testID="feedback-scroll"
			ref={(node) => scroller.set(node)}
			class="flex-1"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={(e) => {
				if (waiting === null) scroll.onScroll(e);
			}}
		>
			<Page testID="feedback">
				<PageHead
					title="Feedback"
					text="Tell Pilot what works and what gets in your way. Your words are saved with the context you choose. Sending feedback approves nothing."
				/>
				<Panel>
					<Column>
						<Compose day={props.day} mirror={mirror} />
						<Sent day={props.day} mirror={mirror} />
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
