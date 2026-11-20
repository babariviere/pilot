// Headless control fixture only. No daemon, worker, provider or storage.
// To check and one delivered result's page over the scripted source with
// the connected rules (deliveryDemo.ts): a command names the exact result
// and revision shown and is sent once; a lost answer stays Unknown until
// Check reads it; Check never sends again; a save and reopen keeps unsent
// notes and sends nothing. Inspect source reads one exact pin's saved
// source once and shows it as plain text; nothing runs it.
import { type JSX, keymap, mount, Scroll, signal, View } from "nsh";
import { FullArtifact } from "./ArtifactViewer";
import { DeliveryScreen } from "./DeliveryScreen";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { type DeliveryPlace, deliveryRoute } from "./deliveryView";
import { ConnectedFeedback, mirrorFeedback } from "./feedbackFeed";
import { openDay } from "./mockFeeds";
import { resultReviewDemo } from "./resultReviewDemo";
import { ToCheck } from "./ToCheck";
import { Block, Button, Buttons, Caption, Column, GridBackdrop, Page, Panel } from "./ui";
import { captureView, restoreView, startFresh } from "./windowState";

const source = new ScriptedDelivery();
const review = resultReviewDemo();
const showReview = signal(false);
const day = { ...openDay(), delivery: mirrorDelivery(source) };
const withFeedback = { ...day, feedback: mirrorFeedback(new ConnectedFeedback("fixture")) };
const showFeedback = signal(false);
/** Shows one mission's To check, as its overview does, instead of Today's. */
const missionOnly = signal(false);
const loseService = () => {
	source.unreadable.add("task/mock-project/native/native-4");
	source.publish();
};
const newResult = () => source.deliverAgain("task/mock-project/native/native-4", "4");

// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => {
	// The full window is a dialog over every control here, so tests reach the result by key.
	keymap.bind("mod+shift+l", loseService, { when: "always" });
	keymap.bind("mod+shift+n", newResult, { when: "always" });
	return (
		<FixtureWindow>
			<View class="flex-1">
				<If
					when={deliveryRoute()}
					else={
						<Scroll class="flex-1">
							<Page width="form">
								<Panel>
									<Column>
										<If when={missionOnly()} else={<ToCheck day={day} nested />}>
											<ToCheck day={day} missionId="native" />
										</If>
									</Column>
								</Panel>
							</Page>
						</Scroll>
					}
				>
					<Each of={deliveryRoute() ? [deliveryRoute() as DeliveryPlace] : []} key={(p) => p.key}>
						{(p) => (
							<DeliveryScreen
								day={showFeedback() ? withFeedback : day}
								place={p()}
								reviewSource={showReview() ? review : undefined}
							/>
						)}
					</Each>
				</If>
				{/* As in the app: one artifact in the whole window, over the page, until closed. */}
				<FullArtifact />
			</View>
			<Scroll class="max-h-48">
				<Block gap={1}>
					<Caption testID="counts">{`Sends: ${source.counts().sends} · Checks: ${source.counts().checks}`}</Caption>
					<Caption testID="last-note">{`Note sent: [${source.counts().note}]`}</Caption>
					<Caption testID="opened">{`Opened: [${source.opened().join(" ")}]`}</Caption>
					<Caption testID="reads">{`Source reads: [${source.reads().join(" ")}]`}</Caption>
					<Caption testID="work-reads">{`Work reads: ${source.workReads().length}`}</Caption>
					<Buttons>
						<Button label="Show linked feedback fixture" onPress={() => showFeedback.set(true)} />
						<Button
							label="Show private review fixture"
							onPress={() => {
								showReview.set(true);
								const result = source.works.get("task/mock-project/native/native-4");
								if (result) result.reviewQueue = "later";
								source.publish();
							}}
						/>
						<Button label="Mission native" onPress={() => missionOnly.set(!missionOnly())} />
						<Button label="Refuse work" onPress={() => (source.refuseWork = "unavailable")} />
						<Button label="Lose next answer" onPress={() => (source.script.loseNext = true)} />
						<Button label="Lose next open" onPress={() => (source.script.loseOpen = true)} />
						<Button
							label="Move link"
							onPress={() =>
								source.moveLink("task/mock-project/native/native-4", "https://github.com/mock/pilot/pull/432")
							}
						/>
						<Button
							label="No browser"
							onPress={() => {
								source.webLinks = false;
								source.publish();
							}}
						/>
						<Button label="Hold answers" onPress={() => (source.script.hold = true)} />
						<Button label="Release answer" onPress={() => source.release()} />
						<Button label="Hold reads" onPress={() => (source.script.holdReads = true)} />
						<Button label="Release reads" onPress={() => source.releaseReads()} />
						<Button label="Leave mission" onPress={() => (source.script.refuseReads = "stale")} />
						<Button label="Close channel" onPress={() => (source.script.refuseReads = "closed")} />
						<Button
							label="Unsaved copies"
							onPress={() => {
								source.unavailable = {
									"3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10": "missing",
									"9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b": "oversize",
								};
							}}
						/>
						<Button
							label="Held back"
							onPress={() => {
								source.unavailable = {
									"3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10": "redacted",
									"9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b": "invalid",
								};
							}}
						/>
						<Button label="Lose service" onPress={loseService} />
						<Button label="New result" onPress={newResult} />
						<Button
							label="Save and reopen"
							onPress={() => {
								const v = captureView(day.today());
								startFresh();
								restoreView(v);
							}}
						/>
					</Buttons>
				</Block>
			</Scroll>
		</FixtureWindow>
	);
});
