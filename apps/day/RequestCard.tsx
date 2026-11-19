// A new Slack request as Needs you's card: what it asks, where it came from,
// the words it quotes and one way to start work. Start asks once more and
// names the exact place (Incoming.tsx); Later and Discard save the request's
// triage, each sent once. Change only shows where work goes, and Open in Slack
// shows the saved message in the browser: neither sends or starts anything.
import { cleanup, effect, signal, Text, View, type ViewRef } from "nsh";
import type { Day } from "./day";
import {
	askStart,
	ConfirmStart,
	canOpenRequest,
	openMissions,
	openRequestLink,
	PlanAction,
	RouteChoice,
	requestBusy,
	requestPlace,
	routeOffered,
	routeWords,
	startedCard,
	starting,
	triageCard,
} from "./Incoming";
import type { IntakeMirror, IntakeRow } from "./intakeFeed";
import { Action, glide, InlineAction, LinkAction, Mark, Panel } from "./ui";
import { anchors, focusFront } from "./view";

/** The key that takes the front card's one next action, as on the other cards. */
const START_KEY = "⌘↩";

/** The request whose routing choice is open, by ID. Opening it sends nothing. */
const changing = signal<string | null>(null);

function Fact(props: { label: string; children: string }) {
	return (
		<View class="flex-row gap-3">
			<Text class="w-24 text-xs text-faint">{props.label}</Text>
			<Text class="line-clamp-2 flex-1 text-sm text-foreground">{props.children}</Text>
		</View>
	);
}

/** Request `props.row`, `props.index` of `props.count` waiting. */
export function RequestCard(props: { day: Day; mirror: IntakeMirror; row: IntakeRow; index: number; count: number }) {
	const r = () => props.row.request;
	const id = `request:${props.row.request.id}`;
	const missions = () => openMissions(props.day.today());
	const busy = () => requestBusy(props.mirror, r().id);
	const place = () => requestPlace(r());
	const facts = () =>
		[
			{ label: "Kind", value: r().kind },
			{ label: "Client", value: r().client },
			{ label: "Reported by", value: r().reporter },
		].filter((f) => f.value);
	// The card's keyboard target: Start work, or the confirmation's Start while it shows.
	const startNode = signal<ViewRef | null>(null);
	const confirmNode = signal<ViewRef | null>(null);
	const target = () => (starting(r().id) ? confirmNode() : startNode()) ?? undefined;
	// Set when the user's own press swaps Start work and the confirmation: the one shown takes the focus.
	const refocus = signal(false);
	effect(() => {
		const node = target();
		if (refocus() && node) {
			refocus.set(false);
			node.focus();
		}
	});
	anchors.set(id, target);
	cleanup(() => anchors.delete(id));
	effect(() => {
		const node = target();
		if (focusFront() && node) {
			node.focus();
			focusFront.set(false);
		}
	});
	return (
		<View testID="request" class="gap-4 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<View class="gap-2">
				<Text role="header" class="text-xl font-semibold leading-snug text-card-foreground">
					{r().title}
				</Text>
				<View class="flex-row flex-wrap items-center gap-1.5">
					<Mark kind="new" />
					<Text class="text-xs text-foreground">{`${r().sourceLabel} request`}</Text>
					<If when={place()}>
						<Text class="text-xs text-muted-foreground">{`· ${place()}`}</Text>
					</If>
					<View class="flex-1" />
					<If when={props.count > 1}>
						<Text class="text-xs text-faint">{`${props.index + 1} of ${props.count}`}</Text>
					</If>
				</View>
			</View>
			<If when={r().quote}>
				<Text class="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{`“${r().quote}”`}</Text>
			</If>
			<If when={facts().length > 0}>
				<Panel class="gap-2">
					<Each of={facts()} key={(f) => f.label}>
						{(f) => <Fact label={f().label}>{f().value}</Fact>}
					</Each>
				</Panel>
			</If>
			<If when={busy()}>
				<Text class="text-sm text-muted-foreground">Waiting for Pilot's answer about this request.</Text>
			</If>
			<If
				when={starting(r().id)}
				else={
					<View class="gap-4">
						<View class="gap-3">
							<View class="flex-row flex-wrap items-baseline gap-x-1.5">
								<Text class="min-w-0 shrink text-xs text-muted-foreground">
									{routeWords(r().id, missions())}
								</Text>
								<InlineAction
									label={changing() === r().id ? "Done" : "Change"}
									testID={`route-change-${r().id}`}
									onPress={() => {
										glide();
										changing.set(changing() === r().id ? null : r().id);
									}}
								/>
							</View>
							<If when={changing() === r().id}>
								<Panel class="gap-3">
									<RouteChoice row={props.row} missions={missions()} busy={busy()} />
									<PlanAction row={props.row} busy={busy()} />
								</Panel>
							</If>
						</View>
						<View class="flex-row flex-wrap items-center gap-2">
							<Action
								variant="primary"
								label="Start work"
								shortcut={START_KEY}
								testID={`start-${r().id}`}
								anchor={(node) => startNode.set(node)}
								disabled={busy() || !routeOffered(r().id, missions())}
								onPress={() => {
									refocus.set(true);
									askStart(props.mirror, props.row);
								}}
							/>
							<Action
								label="Later"
								shortcut="L"
								testID={`later-${r().id}`}
								disabled={busy()}
								onPress={() => void triageCard(props.mirror, props.row, "later")}
							/>
							<Action
								label="Discard"
								testID={`discard-${r().id}`}
								disabled={busy()}
								onPress={() => void triageCard(props.mirror, props.row, "discarded")}
							/>
							<View class="flex-1" />
							<If when={canOpenRequest(props.mirror, props.row)}>
								<LinkAction
									label="Open in Slack"
									testID={`open-slack-${r().id}`}
									onPress={() => void openRequestLink(props.mirror, props.row)}
								/>
							</If>
						</View>
					</View>
				}
			>
				<ConfirmStart
					mirror={props.mirror}
					row={props.row}
					missions={missions()}
					busy={busy()}
					anchor={(node) => confirmNode.set(node)}
					onCancel={() => refocus.set(true)}
					onStarted={startedCard}
				/>
			</If>
		</View>
	);
}
