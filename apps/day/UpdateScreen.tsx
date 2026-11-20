// The update page: Pilot's service, its versions, an update or a
// registration, and one run with its steps and the agents it paused. One
// primary action at a time. Rust prepares a one-use confirmation that names
// the exact versions; confirming it first saves every form, then hands Rust
// where the user is. A lost answer says so and offers only Check again,
// which reads and sends nothing. A finished update is said only once Rust
// reports the new version running.
import { effect, keymap, Scroll, signal, View } from "nsh";
import type {
	AgentLine,
	AgentState,
	Confirmation,
	ServiceView,
	UpdateKind,
	UpdateRun,
	UpdateStepState,
} from "pilot-day/native";
import type { Changes } from "./changeFeed";
import type { Day } from "./day";
import type { Plans } from "./planning";
import {
	Arrive,
	Block,
	Body,
	Button,
	Caption,
	Column,
	EmptyLine,
	glide,
	Mark,
	type MarkKind,
	Notice,
	Page,
	PageHead,
	Panel,
	Question,
	Row,
	Rows,
	type RowTone,
	Section,
} from "./ui";
import type { Update } from "./updateFeed";
import { closeUpdate, updateBusy, updateMessage } from "./updateView";
import { captureView, restoreView, saveForms, startFresh } from "./windowState";

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function agents(n: number): string {
	return `${NUMBERS[n] ?? String(n)} ${n === 1 ? "agent" : "agents"}`;
}

function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What the service's state says, its mark and words. */
export function serviceWords(service: ServiceView): { mark: MarkKind; words: string } {
	switch (service.state) {
		case "registered":
			return { mark: "done", words: "Pilot's service is running" };
		case "absent":
			return { mark: "needs", words: "Pilot's service is not registered" };
		case "offline":
			return { mark: "failed", words: "Pilot's service is not answering" };
		case "incompatible":
			return { mark: "needs", words: "Pilot's service does not match this app" };
		default:
			return { mark: "needs", words: "Pilot cannot tell whether its service is registered" };
	}
}

/** The label of Today's button, or empty when nothing needs the user. */
export function updateLabel(service: ServiceView): string {
	const run = service.run;
	if (run && (run.phase === "unknown" || run.phase === "checking")) return "Update not confirmed";
	if (run && run.phase === "running") return "Updating";
	if (service.state === "absent") return "Register Pilot";
	if (service.state === "offline") return "Service not answering";
	if (service.state === "incompatible") return "Update needed";
	if (service.state === "unknown") return "Check Pilot's service";
	return service.offer ? "Update ready" : "";
}

function kindWords(kind: UpdateKind): string {
	switch (kind) {
		case "app":
			return "for this app";
		case "service":
			return "for Pilot's service";
		case "both":
			return "for this app and Pilot's service";
		default:
			return "";
	}
}

function runTitle(run: UpdateRun): string {
	if (run.kind === "register") {
		switch (run.phase) {
			case "done":
				return "Registered";
			case "stopped":
				return "Not registered";
			case "unknown":
				return "Registration not confirmed";
			case "checking":
				return "Checking the registration…";
			default:
				return "Registering Pilot's service…";
		}
	}
	switch (run.phase) {
		case "done":
			return `Updated to ${run.version}`;
		case "stopped":
			return "Not updated";
		case "unknown":
			return "Update not confirmed";
		case "checking":
			return "Checking the update…";
		default:
			return `Updating to ${run.version}…`;
	}
}

const STEP_MARKS: Record<UpdateStepState, MarkKind> = {
	waiting: "new",
	now: "working",
	done: "done",
	failed: "failed",
	unknown: "needs",
};

const STEP_TONES: Record<UpdateStepState, RowTone> = {
	waiting: "quiet",
	now: "quiet",
	done: "quiet",
	failed: "failed",
	unknown: "needs",
};

const STEP_WORDS: Record<UpdateStepState, string> = {
	waiting: "Waiting",
	now: "Now",
	done: "Done",
	failed: "Stopped here",
	unknown: "Not confirmed",
};

const AGENT_WORDS: Record<AgentState, string> = {
	working: "Working",
	paused: "Paused for the update",
	resuming: "Resume asked, not confirmed yet",
	resumed: "Resumed",
	held: "Left as you paused it",
	unknown: "Needs a look",
};

const AGENT_MARKS: Record<AgentState, MarkKind> = {
	working: "working",
	paused: "paused",
	resuming: "needs",
	resumed: "done",
	held: "paused",
	unknown: "needs",
};

const AGENT_TONES: Record<AgentState, RowTone> = {
	working: "quiet",
	paused: "quiet",
	resuming: "needs",
	resumed: "quiet",
	held: "quiet",
	unknown: "needs",
};

/**
 * What a confirmed update will do, line by line, from Rust's exact
 * confirmation. A count Rust could not take is said as unknown, never as
 * none.
 */
function confirmLines(c: Confirmation): string[] {
	if (c.kind === "register") {
		return [
			"Pilot's service runs in the background and starts when you log in.",
			"macOS may ask you to allow it in Login Items.",
		];
	}
	const lines = ["Saves your drafts and where you are first."];
	const pauses = c.pauses;
	const keeps = c.keeps;
	if (pauses === null || pauses === undefined) {
		lines.push("Pauses all chats. Pilot cannot count working agents yet.");
	} else if (pauses > 0) {
		lines.push(`Pauses ${agents(pauses)} at a safe point, then resumes only ${pauses === 1 ? "it" : "them"}.`);
	} else {
		lines.push("Pauses all chats. No working agents need to resume.");
	}
	if (keeps === null || keeps === undefined) {
		lines.push("Agents you paused stay as you left them.");
	} else if (keeps > 0)
		lines.push(
			`${sentence(agents(keeps))} you paused ${keeps === 1 ? "stays" : "stay"} as you left ${keeps === 1 ? "it" : "them"}.`,
		);
	if (c.restarts) lines.push("Day restarts and comes back to this page.");
	return lines;
}

function say(message: string) {
	updateMessage.set(message);
}

/**
 * The offer the service refused to prepare, by revision and kind. It stays
 * unavailable, with its reason, until Pilot reads the service again.
 */
const refusedOffer = signal("");

function offerKey(service: ServiceView): string {
	return service.offer ? `${service.revision}/${service.offer.kind}` : "";
}

/** Asks Rust for a one-use confirmation of the offer shown. It starts nothing. */
async function prepare(update: Update) {
	const service = update.service();
	const offer = service.offer;
	if (!offer || updateBusy()) return;
	updateBusy.set(true);
	say("");
	glide();
	try {
		const prepared = await update.feed.prepare({ kind: offer.kind, revision: service.revision });
		if (prepared.status === "accepted") return;
		say(prepared.message);
		if (prepared.status === "rejected") refusedOffer.set(offerKey(service));
	} finally {
		updateBusy.set(false);
	}
}

/** Drops the confirmation shown. Nothing was started. */
async function cancel(update: Update) {
	const pending = update.service().pending;
	if (!pending || updateBusy()) return;
	updateBusy.set(true);
	glide();
	try {
		const outcome = await update.feed.cancel({ id: pending.id });
		say(outcome.status === "accepted" ? "" : outcome.message);
	} finally {
		updateBusy.set(false);
	}
}

/**
 * Confirms the update shown, once. Every form is saved to its own store
 * first; a save that fails stops here, before anything pauses, and keeps
 * the text on screen. Then Rust gets where the user is and runs the update.
 */
async function confirm(update: Update, day: Day, plans?: Plans) {
	const pending = update.service().pending;
	if (!pending || updateBusy()) return;
	updateBusy.set(true);
	say("");
	try {
		if (pending.kind !== "register") {
			const forms = await saveForms(day, plans);
			if (!forms.saved) {
				void update.feed.cancel({ id: pending.id });
				say(forms.message);
				return;
			}
		}
		const outcome = await update.feed.confirm({ confirmation: pending.id, view: captureView(day.today()) });
		const run = update.service().run;
		if (outcome.status !== "accepted" && outcome.message !== run?.message) say(outcome.message);
	} finally {
		updateBusy.set(false);
	}
}

/** Reads what happened, or reads the service again. It sends nothing. */
async function check(update: Update) {
	if (updateBusy()) return;
	updateBusy.set(true);
	say("");
	refusedOffer.set("");
	try {
		const outcome = await update.feed.check();
		if (outcome.message !== update.service().run?.message) say(outcome.message);
	} finally {
		updateBusy.set(false);
	}
}

/**
 * After an update restarts the window, shows the saved view once, as a
 * new window: starts fresh, shows the place again, and tells Rust it was
 * shown. That acknowledgement only says the view was shown: it resumes,
 * starts, answers and confirms nothing, and nothing the view holds is sent.
 * A lost or refused acknowledgement is not sent again.
 */
export function bindRestore(update: Update, changes?: Changes, day?: Day) {
	const shown = new Set<string>();
	effect(() => {
		const restore = update.service().restore;
		if (!restore || shown.has(restore.id)) return;
		shown.add(restore.id);
		startFresh();
		restoreView(restore.view, changes, day?.today(), !!day?.linear, !!day?.preferences);
		void update.feed.restored({ id: restore.id });
	});
}

function Offer(props: { update: Update }) {
	const service = () => props.update.service();
	const offer = () => service().offer;
	const refused = () => refusedOffer() !== "" && refusedOffer() === offerKey(service());
	const title = () => {
		const o = offer();
		if (!o) return "";
		return o.kind === "register" ? "Register Pilot's service" : `Pilot ${o.version} is ready ${kindWords(o.kind)}`;
	};
	return (
		<Section title={offer()?.kind === "register" ? "Registration" : "Update"}>
			<Question
				title={title()}
				meta={
					<If when={service().blocked}>
						<Caption testID="update-blocked" tone="needs">
							{service().blocked}
						</Caption>
					</If>
				}
				foot={
					<Button
						kind="primary"
						testID="update-prepare"
						label={offer()?.kind === "register" ? "Register…" : "Update…"}
						disabled={!!service().blocked || updateBusy() || refused()}
						onPress={() => void prepare(props.update)}
					/>
				}
			>
				<Body tone="muted" measure>
					{offer()?.note ?? ""}
				</Body>
			</Question>
		</Section>
	);
}

function Confirm(props: { update: Update; day: Day; plans?: Plans; pending: Confirmation }) {
	const c = () => props.pending;
	const title = () =>
		c().kind === "register"
			? "Register Pilot's service?"
			: c().from
				? `Update from ${c().from} to ${c().to}?`
				: `Update to ${c().to}?`;
	return (
		<Arrive>
			<Section title={c().kind === "register" ? "Registration" : "Update"}>
				<Question
					title={title()}
					foot={
						<>
							<Button
								kind="primary"
								testID="update-confirm"
								label={c().kind === "register" ? "Register" : "Update"}
								disabled={updateBusy()}
								onPress={() => void confirm(props.update, props.day, props.plans)}
							/>
							<Button label="Cancel" disabled={updateBusy()} onPress={() => void cancel(props.update)} />
						</>
					}
				>
					<View class="gap-1">
						<Each of={confirmLines(c())} key={(line) => line}>
							{(line) => (
								<Body tone="muted" measure>
									{line()}
								</Body>
							)}
						</Each>
					</View>
				</Question>
			</Section>
		</Arrive>
	);
}

function Run(props: { update: Update; run: UpdateRun }) {
	const r = () => props.run;
	const lost = () => r().phase === "unknown";
	return (
		<Section title={runTitle(r())} testID="update-run">
			<Rows>
				<Each of={r().steps} key={(s) => s.label}>
					{(s) => (
						<Row
							mark={STEP_MARKS[s().state]}
							title={s().label}
							state={STEP_WORDS[s().state]}
							stateTone={STEP_TONES[s().state]}
						/>
					)}
				</Each>
			</Rows>
			<If when={r().message || r().next || lost()}>
				<Block>
					<If when={r().message}>
						<Body measure>{r().message}</Body>
					</If>
					<If when={r().next}>
						<Body tone="muted" measure>
							{r().next}
						</Body>
					</If>
					<If when={lost()}>
						<Button
							kind="primary"
							testID="update-check"
							label="Check again"
							disabled={updateBusy()}
							onPress={() => void check(props.update)}
						/>
					</If>
				</Block>
			</If>
		</Section>
	);
}

function Agents(props: { agents: AgentLine[] }) {
	return (
		<Section title="Agents" count={props.agents.length}>
			<Rows>
				<Each of={props.agents} key={(a) => a.chat}>
					{(a) => (
						<Row
							mark={AGENT_MARKS[a().state]}
							title={a().chat}
							meta={[a().mission, a().note].filter(Boolean).join(" · ")}
							state={AGENT_WORDS[a().state]}
							stateTone={AGENT_TONES[a().state]}
						/>
					)}
				</Each>
			</Rows>
		</Section>
	);
}

/** The update page, over the screen the user had open. */
export function UpdateScreen(props: { update: Update; day: Day; plans?: Plans }) {
	const service = () => props.update.service();
	const run = () => service().run ?? null;
	const settled = () => {
		const r = run();
		return !r || r.phase === "done" || r.phase === "stopped";
	};
	const words = () => serviceWords(service());
	keymap.bind("escape", () => {
		if (service().pending) void cancel(props.update);
		else closeUpdate();
	});
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead
					title={words().words}
					state={<Mark kind={words().mark} label={words().words} />}
					text={`This app ${service().app} · Service ${service().service || "unknown"}`}
					actions={
						<If when={settled() && !service().pending}>
							<Button
								label="Check again"
								icon="refresh"
								testID="update-read"
								disabled={updateBusy()}
								onPress={() => void check(props.update)}
							/>
						</If>
					}
				>
					<If when={service().reason}>
						<Body tone="muted" measure>
							{service().reason}
						</Body>
					</If>
				</PageHead>
				<Panel
					notice={
						<If when={updateMessage()}>
							<Notice placement="panel" role="alert" text={updateMessage()} />
						</If>
					}
				>
					<Column>
						<Each of={run() ? [run() as UpdateRun] : []} key={() => "run"}>
							{(r) => <Run update={props.update} run={r()} />}
						</Each>
						<If
							when={service().pending}
							else={
								<If when={service().offer && settled()}>
									<Offer update={props.update} />
								</If>
							}
						>
							<Confirm
								update={props.update}
								day={props.day}
								plans={props.plans}
								pending={service().pending as Confirmation}
							/>
						</If>
						<If when={!service().offer && !run() && service().state === "registered"}>
							<Section title="Update">
								<EmptyLine text={service().blocked || "Pilot is up to date."} />
							</Section>
						</If>
						<If when={service().agents.length > 0}>
							<Agents agents={service().agents} />
						</If>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
