// New chat's commands, once. Choosing a project or access level only asks
// Pilot for that project's setup (a passive selection); only Start chat
// sends, naming the exact selection shown and the user's exact words. A
// newer choice makes every older answer meaningless. A creation whose answer
// is lost stays not confirmed: Check reads it, and nothing is sent again.
import type { ChatMirror, ChatMode, ChatView } from "./chatFeed";
import { glide } from "./motion";
import {
	chatChoice,
	chatNote,
	chatPick,
	chatSelecting,
	confirmingStart,
	goalDraft,
	newBusy,
	newMessage,
	restoredDraft,
} from "./planView";

/** The newest choice. An answer to an older one is dropped. */
let selection = 0;
/** The words each creation of this window sent, by operation: Check clears them from New only if unchanged. */
const sentWords = new Map<string, string>();

/** A project's name, or "a project" when Pilot no longer lists it. */
export function projectName(view: ChatView, projectId: string): string {
	return view.projects.find((p) => p.projectId === projectId)?.name ?? "a project";
}

/** How a chat with `mode` may work, in a few words. */
export function modeWords(mode: string): string {
	return mode === "ask" ? "Ask: reads only, changes no files" : "Build: edits files in its own workspace";
}

/**
 * The user chose `projectId` and `mode` (or New chose this window's own
 * project for them). Pilot reads that project's setup; nothing is sent.
 */
export async function chooseChat(chats: ChatMirror, pick: { projectId: string; mode: ChatMode }) {
	const order = ++selection;
	chatPick.set(pick);
	chatChoice.set(null);
	chatNote.set("");
	const project = chats.view().projects.find((p) => p.projectId === pick.projectId);
	if (!project) {
		chatSelecting.set(false);
		chatNote.set("The project you chose is no longer in Pilot. Choose a project.");
		return;
	}
	chatSelecting.set(true);
	try {
		const r = await chats.source.select({
			projectId: project.projectId,
			contextDigest: project.contextDigest,
			mode: pick.mode,
		});
		if (order !== selection) return;
		if (r.status === "accepted" && r.choice) chatChoice.set(r.choice);
		else chatNote.set(r.message);
	} finally {
		if (order === selection) chatSelecting.set(false);
	}
}

/**
 * New opened: reads the projects, then selects the user's earlier choice,
 * else this window's own project. A choice whose project is gone stays
 * unchosen: Pilot never picks another project for the user.
 */
export async function prepareChat(chats: ChatMirror) {
	const order = selection;
	await chats.source.read();
	const restored = restoredDraft();
	if (restored) {
		restoredDraft.set(null);
		chats.source.adopt(restored);
	}
	// The user chose meanwhile: that choice already asked for its setup.
	if (order !== selection) return;
	const view = chats.view();
	if (view.availability !== "live") return;
	const pick = chatPick();
	if (pick) return chooseChat(chats, pick);
	const own = view.current && view.projects.some((p) => p.projectId === view.current) ? view.current : null;
	if (own) return chooseChat(chats, { projectId: own, mode: "build" });
	chatNote.set("Choose a project for this chat.");
}

/** Starts one chat with exactly the goal, in the project and access shown. Sent once. */
export async function startNewChat(chats: ChatMirror) {
	const choice = chatChoice();
	if (newBusy() || !choice || chatSelecting()) return;
	newBusy.set(true);
	newMessage.set("");
	const goal = goalDraft();
	const view = chats.view();
	const where = projectName(view, choice.projectId);
	try {
		const r = await chats.source.create(choice, goal);
		if (r.operationId) sentWords.set(r.operationId, goal);
		if (r.status === "accepted") {
			glide();
			confirmingStart.set(false);
			if (goalDraft() === goal) goalDraft.set("");
			newMessage.set(started(choice.mode, where));
		} else {
			newMessage.set(r.message);
		}
		// The next chat needs a selection of its own. A stale one is read again;
		// an unconfirmed one waits for Check. Selecting sends nothing.
		if (r.status === "stale") await chats.source.read();
		const pick = chatPick();
		if ((r.status === "accepted" || r.status === "stale") && pick) void chooseChat(chats, pick);
	} finally {
		newBusy.set(false);
	}
}

function started(mode: string, where: string): string {
	return `Started one ${mode === "ask" ? "Ask" : "Build"} chat in ${where} with your words. It works on its own; that is not progress or a result yet.`;
}

/** Reads whether an unconfirmed new chat started. Never sends it again. */
export async function checkNewChat(chats: ChatMirror, operationId: string) {
	newMessage.set("");
	const r = await chats.source.check(operationId);
	const view = chats.view();
	const op = view.settled.find((o) => o.operationId === operationId);
	if (r.status === "accepted") {
		const words = sentWords.get(operationId);
		if (words !== undefined && goalDraft() === words) goalDraft.set("");
		newMessage.set(
			`The chat in ${projectName(view, op?.projectId ?? "")} started. It works on its own; that is not progress or a result yet.`,
		);
	} else {
		newMessage.set(r.message);
	}
	// Nothing waits any more: the chosen project can be selected again.
	const pick = chatPick();
	if (r.status !== "unknown" && view.unsettled.length === 0 && pick && !chatChoice()) void chooseChat(chats, pick);
}
