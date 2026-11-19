import { cleanup, effect, signal, Text, untracked, View } from "nsh";
import type { FeedbackItem, FeedbackMirror, FeedbackResultScope } from "./feedbackFeed";
import { clip, stepsOf } from "./feedbackSteps";
import { openFeedback } from "./feedbackView";
import { keepRead } from "./freshness";
import { Action, SectionTitle } from "./ui";

/** Feedback marks are independent of verifying a result. This shows only saved links. */
export function LinkedFeedback(props: { mirror: FeedbackMirror; scope: FeedbackResultScope; disabled?: boolean }) {
	const scope = props.scope;
	const source = props.mirror.source;
	if (!source.readResult) return null;
	const rows = signal<FeedbackItem[]>([]);
	const cursor = signal<number | undefined>(undefined);
	const before = signal<number | null>(null);
	const shown = signal(false);
	const failed = signal(false);
	const messages = signal<Record<string, string>>({});
	const saving = signal(false);
	let alive = true;
	let generation = 0;
	cleanup(() => {
		alive = false;
	});

	const read = async (after: number | undefined) => {
		const request = ++generation;
		const page = await source.readResult!(scope, after);
		if (!alive || request !== generation) return;
		failed.set(!page);
		if (!page) return;
		if (JSON.stringify(rows()) !== JSON.stringify(page.items)) rows.set(page.items);
		cursor.set(after);
		before.set(page.before);
		shown.set(true);
	};
	const reads = keepRead(() => read(cursor()), failed, shown);
	// Watch the feedback cache, not every streaming-change notice. Focus and
	// explicit writes also re-read this result's exact page beyond the cache.
	const view = props.mirror.view;
	let links = "";
	effect(() => {
		const current = JSON.stringify(
			view().items.flatMap((item) =>
				item.work.some(
					(w) =>
						(w.kind === "mission" && scope.kind === "mission" && w.missionId === scope.id) ||
						(w.kind === "fix" && scope.kind === "chat" && w.sessionId === scope.id),
				)
					? [[item.id, item.work.map((w) => w.operationId)]]
					: [],
			),
		);
		if (links !== current) {
			const first = links === "";
			links = current;
			if (!first) untracked(() => void reads.now());
		}
	});
	void reads.now();
	const pending = (id: string) => view().unsettledSteps.find((op) => op.feedbackId === id);
	const write = async (id: string, action?: "resolve" | "reopen", operationId?: string) => {
		if (saving() || props.disabled || (!operationId && (failed() || pending(id)))) return;
		saving.set(true);
		try {
			const result = operationId
				? await source.checkStep(operationId)
				: await source.step({ feedbackId: id, action: action! });
			if (!alive) return;
			messages.update((all) => ({ ...all, [id]: result.message }));
			await reads.now();
		} finally {
			if (alive) saving.set(false);
		}
	};
	return (
		<If when={rows().length > 0 || cursor() !== undefined || reads.warn()}>
			<View testID="result-feedback" class="gap-2">
				<SectionTitle title="Linked feedback" />
				<If when={reads.warn()}>
					<Text class="text-sm text-muted-foreground">Pilot could not read current feedback links.</Text>
				</If>
				<Each of={rows()} key={(item) => item.id}>
					{(item) => {
						const resolved = () => stepsOf(item()).resolved;
						return (
							<View class="gap-2 border-t border-border pt-3">
								<Text class="text-sm font-medium text-foreground">{clip(item().text, 160)}</Text>
								<Text testID={`result-feedback-state-${item().id}`} class="text-xs text-muted-foreground">
									{resolved()
										? "Resolved by you."
										: "Still open. Checking the result does not resolve feedback."}
								</Text>
								<View class="flex-row flex-wrap gap-2">
									<If
										when={pending(item().id)}
										else={
											<Action
												testID={`result-feedback-mark-${item().id}`}
												label={resolved() ? "Reopen" : "Mark resolved"}
												disabled={saving() || view().stepping !== null || failed() || props.disabled}
												onPress={() => void write(item().id, resolved() ? "reopen" : "resolve")}
											/>
										}
									>
										<Action
											label="Check feedback status"
											disabled={saving() || pending(item().id)?.state === "checking" || props.disabled}
											onPress={() => void write(item().id, undefined, pending(item().id)?.operationId)}
										/>
									</If>
									<Action label="Open Feedback" onPress={() => openFeedback(item().origin)} />
								</View>
								<If when={messages()[item().id]}>
									<Text class="text-xs text-muted-foreground">{messages()[item().id]}</Text>
								</If>
							</View>
						);
					}}
				</Each>
				<If when={before() !== null}>
					<Action
						label="Show earlier feedback"
						disabled={saving()}
						onPress={() => void read(before() ?? undefined)}
					/>
				</If>
				<If when={cursor() !== undefined}>
					<Action label="Show newest feedback" disabled={saving()} onPress={() => void read(undefined)} />
				</If>
			</View>
		</If>
	);
}
