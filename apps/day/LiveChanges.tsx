import { cleanup, effect, signal, Text, View } from "nsh";
import type { LiveChangesResult } from "./sessionChat";
import { Action, PatchDiff } from "./ui";

/** A point-in-time read of the chat's working copy, separate from saved results. */
export function LiveChanges(props: {
	workspaceKey: string;
	read: (workspaceKey: string) => Promise<LiveChangesResult>;
}) {
	const opened = signal<string | null>(null);
	const result = signal<LiveChangesResult | null>(null);
	let request = 0;
	const isOpen = () => opened() === props.workspaceKey;
	const visible = () => (isOpen() ? result() : null);
	const read = () => {
		const key = props.workspaceKey;
		if (isOpen() && !result()) return;
		const id = ++request;
		opened.set(key);
		result.set(null);
		void props.read(key).then(
			(next) => {
				if (id === request && props.workspaceKey === key) result.set(next);
			},
			() => {
				if (id === request && props.workspaceKey === key) result.set({ status: "unavailable" });
			},
		);
	};
	const close = () => {
		request++;
		opened.set(null);
		result.set(null);
	};
	effect(() => {
		if (opened() !== null && !isOpen()) close();
	});
	cleanup(() => {
		request++;
	});
	const changes = () => {
		const value = visible();
		return value?.status === "read" ? value : null;
	};
	return (
		<View testID="chat-live-changes" class="gap-2 border-t border-border pt-3">
			<View class="flex-row flex-wrap items-center justify-between gap-2">
				<Text class="text-sm font-semibold text-foreground">Live changes (unpublished)</Text>
				<Action
					testID="chat-live-changes-toggle"
					label={isOpen() ? "Hide changes" : "Inspect changes"}
					onPress={() => (isOpen() ? close() : read())}
				/>
			</View>
			<If when={isOpen()}>
				<Text class="text-xs text-muted-foreground">
					This shows the chat’s working copy when you inspect it. It is not a saved result or proof of what was
					published.
				</Text>
				<If when={!visible()}>
					<Text class="text-sm text-muted-foreground">Reading changes…</Text>
				</If>
				<If when={visible()?.status === "stale" || visible()?.status === "unavailable"}>
					<View class="flex-row flex-wrap items-center gap-2">
						<Text class="text-sm text-muted-foreground">
							{visible()?.status === "stale"
								? "The working copy changed before Pilot could show it."
								: "Pilot could not read this working copy."}
						</Text>
						<Action label="Read again" testID="chat-live-changes-retry" onPress={read} />
					</View>
				</If>
				<If when={changes()}>
					{(entry) => (
						<View class="gap-2">
							<Text class="text-sm text-muted-foreground">
								{entry().fileCount === 0
									? "No changes in this working copy."
									: entry().fileCount === 1
										? "Changes in 1 file."
										: `Changes in ${entry().fileCount} files.`}
							</Text>
							<If when={entry().truncated}>
								<Text class="text-xs text-muted-foreground">This diff is too large to show in full.</Text>
							</If>
							<If when={entry().patch}>
								{(patch) => (
									<View class="h-72 overflow-hidden rounded-lg border border-border">
										<PatchDiff patch={patch()} testID="chat-live-changes-diff" />
									</View>
								)}
							</If>
							<If when={!entry().patch && entry().fileCount > 0}>
								<Text class="text-xs text-muted-foreground">No diff is available to show.</Text>
							</If>
						</View>
					)}
				</If>
			</If>
		</View>
	);
}
