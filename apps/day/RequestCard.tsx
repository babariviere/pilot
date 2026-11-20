// A new Slack request as Needs you's card: what it asks, where it came from,
// the words it quotes and one way to start work. Start asks once more and
// names the exact place (Incoming.tsx); Later and Discard save the request's
// triage, each sent once. Change only shows where work goes, and Open in Slack
// shows the saved message in the browser: neither sends or starts anything.
import { cleanup, effect, signal, View, type ViewRef } from "nsh";
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
import { Body, Button, Caption, Fact, Facts, glide, Link, Question, Spacer, State } from "./ui";
import { anchors, focusFront } from "./view";

/** The key that takes the front card's one next action, as on the other cards. */
const START_KEY = "⌘↩";

/** The request whose routing choice is open, by ID. Opening it sends nothing. */
const changing = signal<string | null>(null);

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
		<Question
			testID="request"
			title={r().title}
			position={props.count > 1 ? `${props.index + 1} of ${props.count}` : undefined}
			meta={
				<>
					<State kind="new" label={`${r().sourceLabel} request`} plain />
					<If when={place()}>
						<Caption>{`· ${place()}`}</Caption>
					</If>
				</>
			}
		>
			<If when={r().quote}>
				<Body tone="muted" measure>{`“${r().quote}”`}</Body>
			</If>
			<If when={facts().length > 0}>
				<Facts>
					<Each of={facts()} key={(f) => f.label}>
						{(f) => <Fact label={f().label}>{f().value}</Fact>}
					</Each>
				</Facts>
			</If>
			<If when={busy()}>
				<Body tone="muted">Waiting for Pilot's answer about this request.</Body>
			</If>
			<If
				when={starting(r().id)}
				else={
					<View class="gap-4">
						<View class="gap-3">
							<View class="flex-row flex-wrap items-baseline gap-x-1.5">
								<Caption>{routeWords(r().id, missions())}</Caption>
								<Link
									label={changing() === r().id ? "Done" : "Change"}
									testID={`route-change-${r().id}`}
									onPress={() => {
										glide();
										changing.set(changing() === r().id ? null : r().id);
									}}
								/>
							</View>
							<If when={changing() === r().id}>
								<View class="gap-3">
									<RouteChoice row={props.row} missions={missions()} busy={busy()} />
									<PlanAction row={props.row} busy={busy()} />
								</View>
							</If>
						</View>
						<View class="flex-row flex-wrap items-center gap-2">
							<Button
								kind="primary"
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
							<Button
								label="Later"
								shortcut="L"
								testID={`later-${r().id}`}
								disabled={busy()}
								onPress={() => void triageCard(props.mirror, props.row, "later")}
							/>
							<Button
								label="Discard"
								testID={`discard-${r().id}`}
								disabled={busy()}
								onPress={() => void triageCard(props.mirror, props.row, "discarded")}
							/>
							<Spacer />
							<If when={canOpenRequest(props.mirror, props.row)}>
								<Link
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
		</Question>
	);
}
