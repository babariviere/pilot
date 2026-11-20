import { computed, signal } from "nsh";
import type { Day } from "../app/day";
import { openChat } from "../sessions/chatView";
import { EmptyLine, Num, Row, Rows, Section } from "../ui";
import type { TodayScope } from "./ScopeRows";

const PREVIEW_ROWS = 5;

/** One recent run per chat. A finished run does not say how its work was reviewed. */
export function FinishedToday(props: { day: Day; ctx: TodayScope }) {
	const expanded = signal<string | null>(null);
	const projects = computed(() => {
		const own = props.ctx.own();
		return [
			...(props.ctx.showsOwn()
				? [{ id: own, name: own ? props.ctx.name(own) : null, today: props.day.today() }]
				: []),
			...props.ctx.others(),
		];
	});
	const date = () =>
		projects()
			.map((p) => p.today?.finishedToday?.date ?? "")
			.sort()
			.at(-1);
	const rows = computed(() =>
		projects()
			.filter((p) => p.today?.finishedToday?.date === date())
			.flatMap((p) =>
				(p.today?.finishedToday?.items ?? []).map((run) => ({
					run,
					project: p.name,
					key: `${p.id ?? ""}/${run.sessionId}`,
				})),
			)
			.sort((a, b) => b.run.outcomeAt - a.run.outcomeAt || a.key.localeCompare(b.key)),
	);
	const complete = () => {
		const scope = props.day.scope?.view().snapshot;
		if (
			props.ctx.on() &&
			props.ctx.scope() === "all" &&
			(!scope?.catalogComplete || scope.scope !== "all" || scope.partial)
		)
			return false;
		return (
			!!date() &&
			projects().every(
				(p) => p.today?.finishedToday?.date === date() && p.today?.finishedToday?.status === "complete",
			)
		);
	};
	const showAll = () => expanded() === props.ctx.scope();
	return (
		<Section
			testID="finished-today"
			title="Finished today"
			count={complete() ? rows().length : null}
			footnote={rows().length > 0 ? "These runs finished. Their results may still need review." : undefined}
			more={
				rows().length > PREVIEW_ROWS
					? {
							label: showAll() ? "Show fewer" : `Show all ${rows().length}`,
							onPress: () => expanded.set(showAll() ? null : props.ctx.scope()),
						}
					: undefined
			}
		>
			<Rows>
				<Each of={showAll() ? rows() : rows().slice(0, PREVIEW_ROWS)} key={(r) => r.key}>
					{(r) => (
						<Row
							title={r().run.title || "Unnamed chat"}
							meta={r().project ?? undefined}
							trailing={<Num>{r().run.localTime}</Num>}
							onPress={props.day.chat ? () => openChat(r().run.sessionId, "Today") : undefined}
							accessibilityLabel={`Open chat: ${r().run.title || "Unnamed chat"}`}
						/>
					)}
				</Each>
			</Rows>
			<If
				when={!complete()}
				else={
					<If when={rows().length === 0}>
						<EmptyLine text="No chat runs finished today." />
					</If>
				}
			>
				<EmptyLine
					text={
						rows().length > 0 ? "Some finished runs may not be shown." : "Finished runs are not available yet."
					}
				/>
			</If>
		</Section>
	);
}
