// Today's presentation mirror. Native owns service selection and credentials;
// the connected source reaches it only through the window's host channel.
import { type Signal, signal } from "nsh";
import type { Today } from "pilot-day/native";
import type { ArtifactSource } from "./artifactReads";
import type { ConnectionControls } from "./connectionControls";
import type { DatabaseControls } from "./databaseControls";
import type { DeliveryMirror } from "./deliveryFeed";
import type { DiagnosisControls } from "./diagnosisControls";
import type { FeedbackMirror } from "./feedbackFeed";
import type { DayFeed } from "./feeds";
import type { IntakeMirror } from "./intakeFeed";
import type { LinearMirror } from "./linearFeed";
import type { ModelControls } from "./modelControls";
import type { PowerControls } from "./power";
import type { PreferencesMirror } from "./preferencesFeed";
import type { ScheduleControls } from "./scheduleControls";
import type { SessionChatMirror } from "./sessionChat";
import type { SlackControls } from "./slackControls";
import type { ThreadsMirror } from "./threadFeed";
import type { ScopeMirror } from "./todayScope";
import { glide } from "./ui";

/** Today's read model as Rust last published it, and the feed to change it. */
export type Day = {
	/** Native AI settings; absent from mock worlds unless explicitly supplied. */
	models?: ModelControls;
	diagnosis?: DiagnosisControls;
	schedules?: ScheduleControls;
	connections?: ConnectionControls;
	databases?: DatabaseControls;
	slack?: SlackControls;
	/** Sends intents. Never written to from TSX state. */
	feed: DayFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	today: Signal<Today>;
	/**
	 * The New section's requests and their Later, Discard and Start. Only the
	 * connected window has them; the mock window shows Today's example rows.
	 */
	intake?: IntakeMirror;
	/**
	 * Delivered results and the user's Done, Send back and Reopen. Only the
	 * connected window has them; the mock window shows no To check.
	 */
	delivery?: DeliveryMirror;
	/**
	 * The user's saved Linear issues and the cycle Pilot last read, for the
	 * read-only Linear page. Only the connected window has them.
	 */
	linear?: LinearMirror;
	/**
	 * Today's cross-project read for the window's project scope. Without it,
	 * Today shows only the window's own project and offers no scope.
	 */
	scope?: ScopeMirror;
	/**
	 * The window's own project's preferences, for Settings. Without them the
	 * window offers no Settings.
	 */
	preferences?: PreferencesMirror;
	/**
	 * Missions' focused threads with their coordinator. Without them a
	 * mission's overview offers no threads.
	 */
	threads?: ThreadsMirror;
	/**
	 * The user's own feedback about Pilot, sent and kept by Pilot's service.
	 * Without it the window offers no feedback page.
	 */
	feedback?: FeedbackMirror;
	/**
	 * Saved artifacts of the window's project and its missions. Without them
	 * the window offers no Artifacts page or mission section.
	 */
	artifacts?: ArtifactSource;
	/**
	 * One chat Pilot started, read only, for the chat page. Without it the
	 * window offers no way into such chats.
	 */
	chat?: SessionChatMirror;
	/** Pilot's pause for sleep and its Resume. Without it the header never shows the pause. */
	power?: PowerControls;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Mirrors `feed`'s read model, mock or connected. Closing stops listening and frees the feeds. */
export function mirrorDay(
	feed: DayFeed,
	features: Pick<
		Day,
		"intake" | "delivery" | "linear" | "scope" | "preferences" | "threads" | "feedback" | "artifacts" | "chat"
	> = {},
): Day {
	const { intake, delivery, linear, scope, preferences, threads, feedback, artifacts, chat } = features;
	const today = signal(feed.snapshot());
	const stop = feed.onChange((next) => {
		// Items that arrive or leave, and missions that change group, glide to
		// their places. Text and state changes in place do not move anything.
		if (shape(next) !== shape(today())) glide();
		today.set(next);
	});
	return {
		feed,
		today,
		intake,
		delivery,
		linear,
		scope,
		preferences,
		threads,
		feedback,
		artifacts,
		chat,
		close: () => {
			stop();
			feed.dispose();
			intake?.close();
			delivery?.close();
			linear?.close();
			preferences?.close();
			threads?.close();
			feedback?.close();
			chat?.close();
		},
	};
}

/** Which items wait and which group each mission is in: what a glide follows. */
function shape(t: Today): string {
	return [
		t.decisions.map((d) => d.id).join(","),
		t.actions.map((a) => a.id).join(","),
		t.moving.map((m) => m.id).join(","),
		t.notMoving.map((m) => m.id).join(","),
		t.unreported.map((m) => m.id).join(","),
		t.intake.requests.map((r) => r.id).join(","),
	].join("|");
}
