import { cleanup, effect, signal, View } from "nsh";
import type { LiveChangesResult } from "./sessionChat";
import { Block, Body, Caption, Link, PatchDiff, Section } from "./ui";

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
		<Section
			testID="chat-live-changes"
			title="Live changes (unpublished)"
			action={
				<Link
					testID="chat-live-changes-toggle"
					label={isOpen() ? "Hide changes" : "Inspect changes"}
					onPress={() => (isOpen() ? close() : read())}
				/>
			}
		>
			<If when={isOpen()}>
				<Block>
					<Caption>
						This shows the chat’s working copy when you inspect it. It is not a saved result or proof of what was
						published.
					</Caption>
					<If when={!visible()}>
						<Body tone="muted">Reading changes…</Body>
					</If>
					<If when={visible()?.status === "stale" || visible()?.status === "unavailable"}>
						<View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-1">
							<Body tone="muted">
								{visible()?.status === "stale"
									? "The working copy changed before Pilot could show it."
									: "Pilot could not read this working copy."}
							</Body>
							<Link label="Read again" testID="chat-live-changes-retry" onPress={read} />
						</View>
					</If>
					<If when={changes()}>
						{(entry) => (
							<>
								<Body tone="muted">
									{entry().fileCount === 0
										? "No changes in this working copy."
										: entry().fileCount === 1
											? "Changes in 1 file."
											: `Changes in ${entry().fileCount} files.`}
								</Body>
								<If when={entry().truncated}>
									<Caption>This diff is too large to show in full.</Caption>
								</If>
								<If when={!entry().patch && entry().fileCount > 0}>
									<Caption>No diff is available to show.</Caption>
								</If>
							</>
						)}
					</If>
				</Block>
				{/* The diff spans the section's width at a fixed height, and scrolls its own rows. */}
				<If when={changes()?.patch}>
					{(patch) => (
						<View class="h-72">
							<PatchDiff patch={patch()} testID="chat-live-changes-diff" />
						</View>
					)}
				</If>
			</If>
		</Section>
	);
}
