// The update page: Pilot's service, its versions, an update or a
// registration, and one run with its steps and the agents it paused. One
// primary action at a time. Rust prepares a one-use confirmation that names
// the exact versions; confirming it first saves every form, then hands Rust
// where the user is. A lost answer says so and offers only Check again,
// which reads and sends nothing. A finished update is said only once Rust
// reports the new version running.
import { effect, keymap, Scroll, signal, Text, View } from "nsh";
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
import { Arrive, glide } from "./motion";
import type { Plans } from "./planning";
import { Action, Mark, type MarkKind, SectionTitle } from "./ui";
import type { Update } from "./updateFeed";
import { captureView, closeUpdate, restoreView, saveForms, startFresh, updateBusy, updateMessage } from "./updateView";

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
			return { mark: "ready", words: "Pilot's service is running" };
		case "absent":
			return { mark: "needs", words: "Pilot's service is not registered" };
		case "offline":
			return { mark: "failed", words: "Pilot's service is not answering" };
		case "incompatible":
			return { mark: "needs", words: "Pilot's service does not match this app" };
		default:
			return { mark: "unknown", words: "Pilot cannot tell whether its service is registered" };
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

function runMark(run: UpdateRun): MarkKind {
	switch (run.phase) {
		case "done":
			return "ready";
		case "stopped":
			return "failed";
		case "unknown":
		case "checking":
			return "unknown";
		default:
			return "moving";
	}
}

const STEP_MARKS: Record<UpdateStepState, MarkKind> = {
	waiting: "unreported",
	now: "moving",
	done: "done",
	failed: "failed",
	unknown: "unknown",
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
	working: "moving",
	paused: "paused",
	resuming: "unknown",
	resumed: "ready",
	held: "paused",
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
		lines.push("Pauses working agents at a safe point. Pilot cannot count them yet.");
	} else if (pauses > 0) {
		lines.push(`Pauses ${agents(pauses)} at a safe point, then resumes only ${pauses === 1 ? "it" : "them"}.`);
	} else if (c.kind === "app") {
		lines.push("Agents keep working; only this app restarts.");
	}
	if (keeps === null || keeps === undefined) {
		if (c.kind !== "app") lines.push("Agents you paused stay as you left them.");
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
function cancel(update: Update) {
	const pending = update.service().pending;
	if (!pending || updateBusy()) return;
	glide();
	void update.feed.cancel({ id: pending.id });
	say("");
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
		restoreView(restore.view, changes, day?.today(), !!day?.linear);
		void update.feed.restored({ id: restore.id });
	});
}

function ServiceLine(props: { service: ServiceView }) {
	const words = () => serviceWords(props.service);
	return (
		<View class="gap-1.5">
			<View class="flex-row items-center gap-2">
				<Mark kind={words().mark} />
				<Text role="header" class="text-xl font-semibold tracking-tight text-foreground">
					{words().words}
				</Text>
			</View>
			<Text class="text-sm text-muted-foreground">
				{`This app ${props.service.app} · Service ${props.service.service || "unknown"}`}
			</Text>
			<If when={props.service.reason}>
				<Text class="text-sm text-muted-foreground">{props.service.reason}</Text>
			</If>
		</View>
	);
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
		<View class="gap-3 rounded-xl bg-muted px-4 py-4">
			<Text class="text-base font-medium text-foreground">{title()}</Text>
			<Text class="text-sm text-muted-foreground">{offer()?.note ?? ""}</Text>
			<If when={service().blocked}>
				<Text testID="update-blocked" class="text-sm text-needs-ink">
					{service().blocked}
				</Text>
			</If>
			<View class="flex-row">
				<Action
					primary
					testID="update-prepare"
					label={offer()?.kind === "register" ? "Register…" : "Update…"}
					disabled={!!service().blocked || updateBusy() || refused()}
					onPress={() => void prepare(props.update)}
				/>
			</View>
		</View>
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
		<Arrive class="gap-3 rounded-xl bg-muted px-4 py-4">
			<Text role="header" class="text-base font-medium text-foreground">
				{title()}
			</Text>
			<View class="gap-1">
				<Each of={confirmLines(c())} key={(line) => line}>
					{(line) => <Text class="text-sm text-muted-foreground">{line()}</Text>}
				</Each>
			</View>
			<View class="flex-row gap-2">
				<Action
					primary
					testID="update-confirm"
					label={c().kind === "register" ? "Register" : "Update"}
					disabled={updateBusy()}
					onPress={() => void confirm(props.update, props.day, props.plans)}
				/>
				<Action label="Cancel" disabled={updateBusy()} onPress={() => cancel(props.update)} />
			</View>
		</Arrive>
	);
}

function Run(props: { update: Update; run: UpdateRun }) {
	const r = () => props.run;
	const lost = () => r().phase === "unknown";
	return (
		<View testID="update-run" class="gap-3">
			<View class="flex-row items-center gap-2">
				<Mark kind={runMark(r())} />
				<Text role="header" class="text-base font-medium text-foreground">
					{runTitle(r())}
				</Text>
			</View>
			<View class="gap-1.5">
				<Each of={r().steps} key={(s) => s.label}>
					{(s) => (
						<View class="flex-row items-center gap-2">
							<Mark kind={STEP_MARKS[s().state]} />
							<Text class="flex-1 text-sm text-foreground">{s().label}</Text>
							<Text class="text-xs text-faint">{STEP_WORDS[s().state]}</Text>
						</View>
					)}
				</Each>
			</View>
			<If when={r().message}>
				<Text class="text-sm text-foreground">{r().message}</Text>
			</If>
			<If when={r().next}>
				<Text class="text-sm text-muted-foreground">{r().next}</Text>
			</If>
			<If when={lost()}>
				<View class="flex-row">
					<Action
						primary
						testID="update-check"
						label="Check again"
						disabled={updateBusy()}
						onPress={() => void check(props.update)}
					/>
				</View>
			</If>
		</View>
	);
}

function Agents(props: { agents: AgentLine[] }) {
	return (
		<View class="gap-1">
			<SectionTitle title="Agents" count={props.agents.length} />
			<Each of={props.agents} key={(a) => a.chat}>
				{(a) => (
					<View class="flex-row items-center gap-3 border-t border-border py-2.5">
						<View class="flex-1 gap-0.5">
							<Text class="text-sm text-foreground">{a().chat}</Text>
							<Text class="text-xs text-faint">{[a().mission, a().note].filter(Boolean).join(" · ")}</Text>
						</View>
						<Mark kind={AGENT_MARKS[a().state]} />
						<Text class="text-xs text-muted-foreground">{AGENT_WORDS[a().state]}</Text>
					</View>
				)}
			</Each>
		</View>
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
	keymap.bind("escape", () => {
		if (service().pending) cancel(props.update);
		else closeUpdate();
	});
	return (
		<Scroll class="flex-1 bg-background">
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<ServiceLine service={service()} />
				<If when={updateMessage()}>
					<Text role="alert" class="text-sm text-needs-ink">
						{updateMessage()}
					</Text>
				</If>
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
					<Text class="text-sm text-muted-foreground">Pilot is up to date.</Text>
				</If>
				<If when={service().agents.length > 0}>
					<Agents agents={service().agents} />
				</If>
				<If when={settled() && !service().pending}>
					<View class="flex-row">
						<Action
							label="Check again"
							icon="refresh"
							testID="update-read"
							disabled={updateBusy()}
							onPress={() => void check(props.update)}
						/>
					</View>
				</If>
			</View>
		</Scroll>
	);
}
