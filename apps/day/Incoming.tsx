// Today's New section: requests from Slack and Linear that nobody started
// in Pilot yet. A row opens in place to show where the request came from.
// Read only: nothing here starts, defers, discards or answers a request,
// and opening a row records nothing. The words come from outside Pilot
// and show as text only.
import { effect, signal, Text, View, type ViewRef } from "nsh";
import { Button, Collapsible } from "nsh/base";
import type { Request, Today } from "pilot-day/native";
import { glide } from "./motion";
import { Mark, SectionTitle } from "./ui";

/** The request open in place, by ID. One at a time; it closes when the request leaves. */
export const openRequest = signal<string | null>(null);

/** "Slack", "Slack and Linear", "Slack, Linear and Jira". */
function joined(names: string[]): string {
	if (names.length < 2) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Where a request came from, in one line: "Slack · #client-northwind · 20 min ago". */
export function requestLine(request: Request): string {
	return [request.sourceLabel, request.place, request.age].filter(Boolean).join(" · ");
}

function toggle(id: string) {
	glide();
	openRequest.set(openRequest() === id ? null : id);
}

function RequestRow(props: { request: Request }) {
	const r = () => props.request;
	const open = () => openRequest() === r().id;
	// The pressed row keeps the keyboard focus, so Space opens or closes it again.
	let node: ViewRef | null = null;
	return (
		<Collapsible
			open={open()}
			class="border-t border-border"
			content={
				<View testID={`request-detail-${r().id}`} class="flex-row gap-2.5 pb-3.5">
					<View class="size-2" />
					<View class="flex-1 gap-2">
						<If when={r().kind}>
							<Text class="text-sm text-foreground">{r().kind}</Text>
						</If>
						<If when={r().link}>
							<Text class="text-xs text-faint">{r().link}</Text>
						</If>
						<Text class="text-sm text-muted-foreground">
							Pilot Day cannot start, defer or discard requests yet. Start it from the Inbox in Pilot.
						</Text>
					</View>
				</View>
			}
		>
			<Button
				ref={(n: ViewRef) => {
					node = n;
				}}
				testID={`request-${r().id}`}
				accessibilityLabel={`${r().title}, new from ${r().sourceLabel}. ${open() ? "Hide" : "Show"} where it came from.`}
				onPress={() => {
					toggle(r().id);
					node?.focus();
				}}
				class="group gap-1 rounded-md py-3.5 focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				<View class="flex-row items-center gap-2.5">
					<Mark kind="new" />
					<Text class="flex-1 text-sm font-medium text-foreground group-hover:underline">{r().title}</Text>
					<Text class="text-xs text-muted-foreground">New</Text>
				</View>
				<View class="flex-row gap-2.5">
					<View class="size-2" />
					<Text class="flex-1 text-xs text-faint">{requestLine(r())}</Text>
				</View>
			</Button>
		</Collapsible>
	);
}

/**
 * New requests, newest first. Hidden when no request source is set up. A
 * source that cannot be read says so and keeps what Pilot read before;
 * rows the read holds but does not show are counted, so the list never
 * looks complete when it is not.
 */
export function Incoming(props: { today: Today }) {
	const intake = () => props.today.intake;
	// A request that left (started elsewhere, read again) closes.
	effect(() => {
		const id = openRequest();
		if (id && !intake().requests.some((r) => r.id === id)) openRequest.set(null);
	});
	const shown = () => intake().requests;
	const empty = () =>
		intake().trouble.length > 0
			? "No new requests in what Pilot read."
			: `No new requests. ${joined(intake().sources)} ${intake().sources.length === 1 ? "is" : "are"} quiet.`;
	return (
		<If when={intake().watched}>
			<View testID="incoming" class="gap-1">
				<View class="pb-1">
					<SectionTitle title="New" count={shown().length}>
						<Text class="text-xs text-faint">{`From ${joined(intake().sources)}`}</Text>
					</SectionTitle>
				</View>
				<Each of={intake().trouble} key={(t) => t}>
					{(t) => (
						<View class="mb-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
							<Mark kind="unknown" />
							<Text class="flex-1 text-sm text-foreground">{t()}</Text>
						</View>
					)}
				</Each>
				<If when={shown().length > 0} else={<Text class="text-sm text-muted-foreground">{empty()}</Text>}>
					<Each of={shown()} key={(r) => r.id}>
						{(r) => <RequestRow request={r()} />}
					</Each>
				</If>
				<If when={intake().more}>
					<Text testID="incoming-more" class="pt-1 text-xs text-faint">
						{intake().more}
					</Text>
				</If>
			</View>
		</If>
	);
}
