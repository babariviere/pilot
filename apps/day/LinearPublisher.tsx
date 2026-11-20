import { cleanup, effect, signal, untracked, View } from "nsh";
import { AutoCheck } from "./autoCheck";
import { call, windowId } from "./bridge";
import {
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Checkbox,
	Heading,
	Link,
	MarkdownPreview,
	Notice,
	Spacer,
} from "./ui";

type IssueText = { title: string; description: string };
type Issue = { identifier: string; url: string };
type Draft = {
	taskId: string;
	after: IssueText;
	before: IssueText | null;
	issue: Issue | null;
	change: "create" | "update" | "unchanged" | "manual";
};
type Preview = {
	parent: Issue & { title: string };
	issues: Draft[];
	links: {
		from: string;
		to: string;
		label: string;
		change: "add" | "present" | "kept" | "removed-in-linear" | "later";
	}[];
	edits: { taskId: string; issue: Issue; sent: IssueText; current: IssueText }[];
	pin: string | null;
};
export type PublisherSnapshot = {
	missionId: string;
	projectName: string;
	enabled: boolean;
	revision: number;
	parentUrls: string[];
	tasks: { id: string; number: number; title: string }[];
	mappings: (Issue & { taskId: string; title: string; removed: boolean })[];
	pending: string | null;
	preview: Preview | null;
	message: string;
};
type Selection = { parentUrl: string; taskIds: string[] };
export type PublisherIntent =
	| { action: "read" | "check" }
	| { action: "setting"; enabled: boolean; revision: number }
	| ({ action: "preview" } & Selection)
	| ({ action: "publish" | "reconcile"; pin: string } & Selection);
type Request = (missionId: string, intent: PublisherIntent) => Promise<PublisherSnapshot | null>;

const connected: Request = async (missionId, intent) => {
	const window = windowId();
	if (!window) return null;
	const r = await call<PublisherSnapshot>(window, `day.linearPublisher.${intent.action}`, { missionId, intent });
	return r.ok && r.snapshot?.missionId === missionId ? r.snapshot : null;
};

/** A sub-heading inside the publisher: it sits in a `Block` of the mission's section, so it is not a `Section`. */
function Part(props: { title: string }) {
	return <Caption role="header">{props.title}</Caption>;
}

function Copy(props: { text: string; label?: string }) {
	return (
		<View selectable class="gap-1">
			<If when={props.label}>
				<Caption>{props.label ?? ""}</Caption>
			</If>
			<Body>{props.text}</Body>
		</View>
	);
}

function IssueDescription(props: { markdown: string; label?: string }) {
	return (
		<View class="gap-1">
			<If when={props.label}>
				<Caption>{props.label ?? ""}</Caption>
			</If>
			<If when={props.markdown} else={<Body tone="muted">No description.</Body>}>
				<MarkdownPreview markdown={props.markdown} />
			</If>
		</View>
	);
}

function IssueDraft(props: { row: Draft }) {
	const opened = signal(false);
	return (
		<View class="gap-2">
			<View class="flex-row items-start gap-2">
				<View class="min-w-0 flex-1">
					<BodyStrong>
						{(props.row.issue ? `${props.row.issue.identifier} · ` : "") + props.row.after.title}
					</BodyStrong>
					<Caption>
						{
							{
								create: "Creates a sub-issue",
								update: "Updates this issue",
								unchanged: "Unchanged",
								manual: "Needs an edit in Linear",
							}[props.row.change]
						}
					</Caption>
				</View>
				<Button
					small
					label={opened() ? "Hide issue draft" : props.row.before ? "Show changes" : "Show issue draft"}
					testID={`linear-publish-draft-${props.row.taskId}`}
					accessibilityLabel={`${opened() ? "Hide" : "Show"} issue draft for ${props.row.after.title}`}
					onPress={() => opened.set(!opened())}
				/>
			</View>
			<If when={opened()}>
				<View class="gap-3">
					<If when={props.row.before && props.row.before.title !== props.row.after.title}>
						<Copy label="Previous title" text={props.row.before?.title ?? ""} />
						<Copy label="New title" text={props.row.after.title} />
					</If>
					<If when={props.row.before && props.row.before.description !== props.row.after.description}>
						<IssueDescription label="Previous description" markdown={props.row.before?.description ?? ""} />
					</If>
					<IssueDescription
						label={props.row.change === "update" ? "Description after this update" : "Description"}
						markdown={props.row.after.description}
					/>
				</View>
			</If>
		</View>
	);
}

/** Explicit commands only. Leaving the panel never retries a write. */
export function LinearPublisher(props: { missionId: string; request?: Request }) {
	const open = signal(false);
	const snapshot = signal<PublisherSnapshot | null>(null);
	const busy = signal<PublisherIntent["action"] | null>(null);
	const trouble = signal("");
	const unknown = signal(false);
	const parent = signal("");
	const tasks = signal<string[]>([]);
	const settings = signal(false);
	const send = props.request ?? connected;
	let disposed = false;
	cleanup(() => {
		disposed = true;
	});

	const load = async (op: PublisherIntent) => {
		if (busy() || disposed) return;
		busy.set(op.action);
		// A lookup keeps the words about the publish it looks up until it settles it.
		if (op.action !== "check") trouble.set("");
		try {
			const next = await send(props.missionId, op);
			if (disposed) return;
			if (!next) {
				if (op.action === "check") return;
				if (op.action === "publish") unknown.set(true);
				trouble.set(
					op.action === "publish"
						? "Pilot did not hear back. It will not resend the publish."
						: "Pilot could not read the Linear publisher. Try again.",
				);
				return;
			}
			unknown.set(false);
			if (!next.pending) trouble.set("");
			snapshot.set(next);
			if (!next.parentUrls.includes(parent())) parent.set(next.parentUrls.length === 1 ? next.parentUrls[0]! : "");
			tasks.set(tasks().filter((id) => next.tasks.some((t) => t.id === id)));
		} catch {
			if (disposed) return;
			if (op.action === "publish") unknown.set(true);
			trouble.set("Pilot could not confirm the request. Check its status before trying again.");
		} finally {
			if (!disposed) busy.set(null);
		}
	};
	const start = async () => {
		open.set(true);
		await load({ action: "read" });
	};
	const view = () => snapshot();
	const draft = () => view()?.preview;
	const conflict = () => !!draft()?.edits.length || !!draft()?.links.some((l) => l.change === "removed-in-linear");
	const needsCheck = () => !!view()?.pending || unknown();
	// A publish Pilot did not hear back about is looked up by its receipt automatically; Check is the fallback.
	const auto = new AutoCheck(
		() => load({ action: "check" }),
		() => {},
	);
	cleanup(() => auto.close());
	effect(() => {
		const follow = open() && needsCheck();
		untracked(() => auto.watch(follow ? [props.missionId] : []));
	});
	const reset = () => {
		const last = snapshot();
		if (last) snapshot.set({ ...last, preview: null });
	};
	const preview = () => load({ action: "preview", parentUrl: parent(), taskIds: tasks() });
	const confirm = async (action: "publish" | "reconcile") => {
		const pin = draft()?.pin;
		if (!pin || busy() || needsCheck()) return;
		// Remove the old button before dispatch. An absent reply can only be checked.
		reset();
		await load({ action, pin, parentUrl: parent(), taskIds: tasks() });
	};
	const count = (kind: Draft["change"]) => draft()?.issues.filter((i) => i.change === kind).length ?? 0;
	return (
		<View class="gap-3" testID="linear-publisher">
			<View class="flex-row items-center gap-2">
				<Heading role="header">Linear</Heading>
				<Spacer />
				<Button
					small
					label={open() ? "Close publisher" : "Publish tasks to Linear"}
					testID="linear-publisher-open"
					disabled={!!busy()}
					onPress={() => (open() ? open.set(false) : void start())}
				/>
			</View>
			<If when={open()}>
				<View class="gap-4">
					<If when={busy()}>
						<Body tone="muted">
							{busy() === "publish"
								? "Sending confirmed changes to Linear…"
								: busy() === "setting"
									? "Saving project setting…"
									: "Checking Linear publishing…"}
						</Body>
					</If>
					{/* A problem the user can act on is a notice; the service's plain answer is a line. */}
					<If when={trouble() || (needsCheck() && view()?.message)}>
						<Notice text={trouble() || view()?.message || ""} />
					</If>
					<If when={!trouble() && !needsCheck() && view()?.message}>
						<Body role="alert" tone="muted">
							{view()?.message ?? ""}
						</Body>
					</If>
					<If when={needsCheck()}>
						<View class="gap-2">
							<Copy
								text={
									view()?.pending
										? `Waiting for Linear to confirm: ${view()?.pending}`
										: "The publish is not confirmed."
								}
							/>
							<Buttons>
								<Button
									kind="primary"
									label="Check status"
									disabled={!!busy()}
									testID="linear-publish-check"
									onPress={() => void load({ action: "check" })}
								/>
							</Buttons>
						</View>
					</If>
					<If when={!view() && trouble() && !needsCheck()}>
						<Buttons>
							<Button label="Try again" disabled={!!busy()} onPress={() => void start()} />
						</Buttons>
					</If>
					<If when={view()}>
						<View class="gap-2">
							<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
								<Body tone="muted">{`${view()?.projectName} · Publishing ${view()?.enabled ? "on" : "off"}`}</Body>
								<Link
									label={settings() ? "Hide project setting" : "Project setting"}
									onPress={() => settings.set(!settings())}
								/>
							</View>
							<If when={settings()}>
								<View class="gap-1">
									<Checkbox
										label="Allow publishing in this project"
										testID="linear-publish-enable"
										checked={view()?.enabled ?? false}
										disabled={!!busy()}
										onChange={() => {
											const v = view();
											if (v) void load({ action: "setting", enabled: !v.enabled, revision: v.revision });
										}}
									/>
									<Caption>Allows confirmed writes only. Does not manage issue status.</Caption>
								</View>
							</If>
						</View>
						<If when={(view()?.mappings.length ?? 0) > 0}>
							<View class="gap-1">
								<Part title="Published issues" />
								<Each of={view()?.mappings ?? []} key={(m) => m.taskId}>
									{(m) => (
										<Copy
											text={
												m().identifier +
												" · " +
												m().title +
												(m().removed ? " · Removed from plan, kept in Linear" : "")
											}
										/>
									)}
								</Each>
							</View>
						</If>
						<If when={!needsCheck() && !draft()}>
							<View class="gap-3">
								<Part title="Parent issue" />
								<If when={!view()?.parentUrls.length}>
									<Body tone="muted">Link a Linear issue to this mission to use it as the parent.</Body>
								</If>
								<Each of={view()?.parentUrls ?? []} key={(url) => url}>
									{(url) => (
										<Checkbox
											label={url()}
											disabled={!!busy()}
											checked={parent() === url()}
											onChange={() => parent.set(parent() === url() ? "" : url())}
										/>
									)}
								</Each>
								<Part title="Approved tasks" />
								<Body tone="muted">
									{view()?.tasks.length
										? "Select up to 8 tasks. Only these issue drafts will be sent."
										: "No approved tasks with publishable outcomes and criteria."}
								</Body>
								<Each of={view()?.tasks ?? []} key={(t) => t.id}>
									{(t) => (
										<Checkbox
											testID={`linear-publish-task-${t().id}`}
											label={`#${t().number} ${t().title}`}
											checked={tasks().includes(t().id)}
											disabled={!!busy() || (tasks().length >= 8 && !tasks().includes(t().id))}
											onChange={() =>
												tasks.set(
													tasks().includes(t().id)
														? tasks().filter((id) => id !== t().id)
														: [...tasks(), t().id],
												)
											}
										/>
									)}
								</Each>
								<Buttons>
									<Button
										kind="primary"
										label="Preview changes"
										testID="linear-publish-preview"
										disabled={!!busy() || !parent() || !tasks().length}
										onPress={() => void preview()}
									/>
								</Buttons>
							</View>
						</If>
						<If when={draft()}>
							{(review) => (
								<View class="gap-3">
									<Part title="Parent issue" />
									<Copy
										label={`${review().parent.identifier} · ${review().parent.title}`}
										text={review().parent.url}
									/>
									<Part title="Changes to publish" />
									<Each of={review().issues} key={(i) => i.taskId}>
										{(i) => <IssueDraft row={i()} />}
									</Each>
									<Part title="Blocking links" />
									<If when={!review().links.length}>
										<Body tone="muted">No Linear links will be created.</Body>
									</If>
									<Each of={review().links} key={(e) => `${e.from}/${e.to}`}>
										{(e) => (
											<Copy
												text={
													e().label +
													" · " +
													{
														add: "Add link",
														present: "Already linked",
														kept: "Kept in Linear",
														later: "Not in this publish. Preview again for this link.",
														"removed-in-linear": "Removed in Linear",
													}[e().change]
												}
											/>
										)}
									</Each>
									<If when={conflict()}>
										<Part title="Review edits in Linear" />
										<Each of={review().edits} key={(e) => e.taskId}>
											{(e) => (
												<View class="gap-2">
													<Copy
														label={`${e().issue.identifier} · Last sent by Pilot`}
														text={e().sent.title}
													/>
													<IssueDescription markdown={e().sent.description} />
													<Copy label="Current in Linear" text={e().current.title} />
													<IssueDescription markdown={e().current.description} />
												</View>
											)}
										</Each>
										<Body tone="muted">
											Use the current Linear values for comparison. This changes neither Linear nor the plan.
											Preview again before publishing.
										</Body>
									</If>
									<If when={!conflict()}>
										<If when={count("manual") > 0}>
											<Body tone="muted">
												Pilot cannot safely replace a title or empty description. Make that edit in Linear
												and preview again, or change the selection.
											</Body>
										</If>
										<Body tone="muted">
											{count("create") +
												" to create · " +
												count("update") +
												" to update · " +
												review().links.filter((l) => l.change === "add").length +
												" blocking links to add"}
										</Body>
										<If when={!view()?.enabled}>
											<Body tone="muted">Publishing is off for this project.</Body>
										</If>
									</If>
									<Buttons>
										<If
											when={conflict()}
											else={
												<Button
													kind="primary"
													label={count("update") ? "Publish changes" : "Publish to Linear"}
													testID="linear-publish-confirm"
													disabled={!!busy() || !view()?.enabled || !review().pin}
													onPress={() => void confirm("publish")}
												/>
											}
										>
											<Button
												kind="primary"
												label="Use current Linear version"
												disabled={!!busy() || !review().pin}
												onPress={() => void confirm("reconcile")}
											/>
										</If>
										<Button label="Change selection" disabled={!!busy()} onPress={reset} />
									</Buttons>
								</View>
							)}
						</If>
					</If>
				</View>
			</If>
		</View>
	);
}
