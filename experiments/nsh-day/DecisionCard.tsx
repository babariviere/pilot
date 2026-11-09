// The decision in front: what Pilot asks, help to decide, the choices, and
// where the answer is. Rust decides every state change; this card sends
// intents and shows the outcome Rust publishes.
import { Text, View } from "nsh";
import { Input, Radio, RadioGroup } from "nsh/base";
import type { Decision } from "pilot-day/native";
import type { Day } from "./day";
import { Action, EvidenceChip, HelpChip, Mark, type MarkKind } from "./ui";
import { asking, chosen, drafts, type Help, helpOpen, messages, picks, setFor, setHelp } from "./view";

/** The mark a decision shows. */
export function decisionMark(decision: Decision): MarkKind {
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "unknown";
	if (decision.kind === "failure") return "failed";
	if (decision.kind === "review") return "ready";
	return "needs";
}

function commitLabel(decision: Decision): string {
	if (decision.kind === "review") return "Approve";
	if (decision.kind === "approval") return "Confirm";
	return "Decide";
}

/** One sentence about where the user's answer is, or nothing while idle. */
function deliveryLine(decision: Decision): string {
	switch (decision.delivery) {
		case "sending":
			return "Sending your answer…";
		case "checking":
			return "Checking. This only reads; it changes nothing.";
		case "unknown":
			return decision.kind === "unknown"
				? ""
				: "Pilot sent your answer but heard nothing back. It will not send it again until it checks.";
		default:
			return "";
	}
}

/** The decision `props.decision`, `props.index` of `props.count` waiting. */
export function DecisionCard(props: { day: Day; decision: Decision; index: number; count: number }) {
	const d = () => props.decision;
	const idle = () => d().delivery === "idle";
	const needsCheck = () => d().delivery === "unknown";
	const say = (id: string, message: string) => setFor(messages, id, message);
	const toggle = (kind: Help) => (open: boolean) => setHelp(d().id, kind, open);

	const decide = async () => {
		const now = d();
		say(now.id, "");
		const outcome = await props.day.feed.decide({
			decisionId: now.id,
			revision: now.revision,
			optionId: chosen(now),
		});
		say(now.id, outcome.message);
	};
	const check = async () => {
		const now = d();
		say(now.id, "");
		const outcome = await props.day.feed.check({ decisionId: now.id, revision: now.revision });
		say(now.id, outcome.message);
	};
	const later = () => {
		const now = d();
		const outcome = props.day.feed.later({ decisionId: now.id, revision: now.revision });
		say(now.id, outcome.message);
	};
	const ask = async () => {
		const now = d();
		const question = drafts()[now.id] ?? "";
		if (asking()[now.id]) return;
		setFor(asking, now.id, true);
		const outcome = await props.day.feed.ask({ decisionId: now.id, question });
		setFor(asking, now.id, false);
		// Clear only the text that was sent; keep anything typed meanwhile.
		if (outcome.status === "accepted" && (drafts()[now.id] ?? "") === question) setFor(drafts, now.id, "");
		say(now.id, outcome.message);
	};

	return (
		<View testID="decision" class="gap-4 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<View class="gap-2">
				<Text role="header" class="text-xl font-semibold leading-snug text-card-foreground">
					{d().title}
				</Text>
				<View class="flex-row flex-wrap items-center gap-1.5">
					<Mark kind={decisionMark(d())} />
					<Text
						class="text-xs"
						classList={{
							"text-needs-ink": decisionMark(d()) === "needs" || decisionMark(d()) === "unknown",
							"text-failed-ink": decisionMark(d()) === "failed",
							"text-ok-ink": decisionMark(d()) === "ready",
						}}
					>
						{d().reason}
					</Text>
					<Text class="text-xs text-muted-foreground">{`· ${d().missionTitle} · ${d().effort}`}</Text>
					<View class="flex-1" />
					<If when={props.count > 1}>
						<Text class="text-xs text-faint">{`${props.index + 1} of ${props.count}`}</Text>
					</If>
				</View>
			</View>

			<Text class="text-sm leading-relaxed text-card-foreground">
				{helpOpen(d().id, "simpler") ? d().simpler : d().context}
			</Text>

			<View class="flex-row flex-wrap gap-1.5">
				<HelpChip label="Say it simpler" pressed={helpOpen(d().id, "simpler")} onChange={toggle("simpler")} />
				<HelpChip label="More context" pressed={helpOpen(d().id, "more")} onChange={toggle("more")} />
				<HelpChip label="Ask a question" pressed={helpOpen(d().id, "ask")} onChange={toggle("ask")} />
				<If when={d().details}>
					<HelpChip label="What was pushed" pressed={helpOpen(d().id, "details")} onChange={toggle("details")} />
				</If>
			</View>

			<If when={helpOpen(d().id, "more")}>
				<View class="gap-1.5 rounded-xl bg-muted px-4 py-3">
					<Each of={d().more} key={(line) => line}>
						{(line) => <Text class="text-sm text-foreground">{line()}</Text>}
					</Each>
				</View>
			</If>

			<If when={helpOpen(d().id, "details") && d().details}>
				<View class="rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm text-foreground">{d().details ?? ""}</Text>
				</View>
			</If>

			<If when={helpOpen(d().id, "ask")}>
				<View class="gap-3 rounded-xl bg-muted px-4 py-3">
					<Each of={d().answers} key={(a) => `${a.question}\u0000${a.answer}`}>
						{(a) => (
							<View class="gap-1">
								<Text class="text-sm text-muted-foreground">{a().question}</Text>
								<Text class="text-sm text-foreground">{a().answer}</Text>
							</View>
						)}
					</Each>
					<View class="flex-row items-center gap-2">
						<Input
							testID="question"
							value={drafts()[d().id] ?? ""}
							onChange={({ value }) => setFor(drafts, d().id, value)}
							onSubmit={ask}
							submitBehavior="submit"
							placeholder="Ask about this decision"
							class="min-h-8 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
						/>
						<Action
							label={asking()[d().id] ? "Asking…" : "Ask"}
							disabled={asking()[d().id] === true}
							onPress={ask}
						/>
					</View>
				</View>
			</If>

			<If when={d().tried.length > 0}>
				<View class="gap-1 pl-1">
					<Each of={d().tried} key={(line) => line}>
						{(line) => <Text class="text-xs text-muted-foreground">{`• ${line()}`}</Text>}
					</Each>
				</View>
			</If>

			<Text class="text-xs leading-relaxed text-muted-foreground">{d().boundary}</Text>

			<If when={d().options.length > 1}>
				<RadioGroup class="gap-1">
					<Each of={d().options} key={(o) => o.id}>
						{(o) => (
							<Radio
								checked={chosen(d()) === o().id}
								disabled={!idle()}
								onChange={() => setFor(picks, d().id, o().id)}
								class="group flex-row gap-3 rounded-xl px-3 py-2.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
							>
								<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
									<View class="size-2 rounded-full group-checked:bg-primary" />
								</View>
								<View class="flex-1 gap-0.5">
									<View class="flex-row flex-wrap items-baseline gap-2">
										<Text class="text-sm font-medium text-card-foreground">{o().label}</Text>
										<If when={o().recommended}>
											<Text class="text-xs text-muted-foreground">Recommended</Text>
										</If>
									</View>
									<Text class="text-xs text-muted-foreground">{o().detail}</Text>
								</View>
							</Radio>
						)}
					</Each>
				</RadioGroup>
			</If>

			<If when={deliveryLine(d())}>
				<Text role="alert" class="text-sm text-muted-foreground">
					{deliveryLine(d())}
				</Text>
			</If>
			<If when={messages()[d().id]}>
				<Text role="alert" class="text-sm text-needs-ink">
					{messages()[d().id] ?? ""}
				</Text>
			</If>

			<View class="flex-row flex-wrap items-center gap-2">
				<If
					when={needsCheck() || d().delivery === "checking"}
					else={<Action primary label={commitLabel(d())} disabled={!idle()} onPress={decide} />}
				>
					<Action primary label="Check again" disabled={d().delivery === "checking"} onPress={check} />
				</If>
				<If when={props.count > 1}>
					<Action label="Later" disabled={!idle()} onPress={later} />
				</If>
			</View>

			<If when={d().evidence.length > 0}>
				<View class="flex-row flex-wrap gap-1.5">
					<Each of={d().evidence} key={(e) => e.label}>
						{(e) => <EvidenceChip evidence={e()} />}
					</Each>
				</View>
			</If>
		</View>
	);
}
