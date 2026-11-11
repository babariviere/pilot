// A source opens in place. The map, interview, draft and their native views stay mounted.
import { cleanup, effect, keymap, signal, Text, View, type ViewRef } from "nsh";
import type { MapSource, PlanPage } from "pilot-day/native";
import { exactSource, type MapSourceDetail, type MapSourceRequest } from "./mapSourceContract";
import type { Plans } from "./planning";
import { Action } from "./ui";

/** Original records, alongside the map question or fog area that cites them. Reading changes nothing. */
export function MapSources(props: {
	plans: Plans;
	page: PlanPage;
	area: "item" | "fog";
	recordId: string;
	refs: MapSource[];
}) {
	return (
		<View class="gap-2">
			<Each of={props.refs} key={(r) => `${r.kind}/${r.id}`}>
				{(r) => (
					<Original
						plans={props.plans}
						page={props.page}
						area={props.area}
						recordId={props.recordId}
						source={r()}
					/>
				)}
			</Each>
		</View>
	);
}

function Original(props: { plans: Plans; page: PlanPage; area: "item" | "fog"; recordId: string; source: MapSource }) {
	const open = signal(false);
	const busy = signal(false);
	const read = signal<{ at: number; detail: MapSourceDetail } | null>(null);
	let generation = 0;
	let anchor: ViewRef | undefined;
	const request = (): MapSourceRequest => ({
		missionId: props.page.missionId,
		planRevision: props.page.map?.revision ?? 0,
		area: props.area,
		recordId: props.recordId,
		kind: props.source.kind,
		id: props.source.id,
	});
	// A later read/invalidation removes the old content at once, not merely its controls.
	const detail = () => {
		const saved = read();
		return saved &&
			saved.at === props.plans.planning().revision &&
			props.page.available &&
			props.page.fresh &&
			exactSource(request(), saved.detail)
			? saved.detail
			: null;
	};
	const close = () => {
		generation++;
		open.set(false);
		busy.set(false);
		read.set(null);
		anchor?.focus();
	};
	cleanup(() => {
		generation++;
	});
	effect(() => {
		if (!open()) return;
		const stop = keymap.bind("escape", close, { when: "always" });
		cleanup(stop);
	});
	const load = async () => {
		const token = ++generation;
		const at = props.plans.planning().revision;
		const shown = request();
		open.set(true);
		busy.set(true);
		read.set(null);
		try {
			const result = await props.plans.feed.readSource?.(shown);
			if (token !== generation) return;
			if (result?.status === "available" && exactSource(shown, result.detail))
				read.set({ at, detail: result.detail });
		} catch {
			/* A failed passive read never keeps an earlier body. */
		} finally {
			if (token === generation) busy.set(false);
		}
	};
	return (
		<View testID={`source-${props.recordId}-${props.source.id}`} class="gap-2">
			<Action
				label={`Open ${props.source.label}`}
				anchor={(node) => {
					anchor = node;
				}}
				onPress={() => void load()}
				disabled={busy()}
			/>
			<If when={open()}>
				<View testID="original-source" selectable class="gap-3 rounded-xl bg-muted px-4 py-3">
					<Text class="text-xs text-faint">{`From this map · ${props.source.kind} ${props.source.id}`}</Text>
					<If
						when={detail()}
						else={
							<Text class="text-sm text-muted-foreground">
								{busy()
									? "Reading the original source…"
									: "Source unavailable or currentness unknown. Earlier content is hidden. Nothing was answered or accepted."}
							</Text>
						}
					>
						<Text role="header" class="text-base font-medium text-foreground">
							{detail()?.title}
						</Text>
						<Text class="text-xs text-muted-foreground">
							{detail()?.currentness === "current"
								? "Current source. Reading is not approval or acceptance."
								: "Stale citation. This record is history, not current agreement."}
						</Text>
						<Text class="text-sm leading-relaxed text-foreground">{detail()?.body}</Text>
						<If when={detail()?.check}>
							<Text class="text-xs text-muted-foreground">{detail()?.check}</Text>
						</If>
						<Each of={detail()?.history ?? []} key={(line) => line}>
							{(line) => <Text class="text-xs text-muted-foreground">{line()}</Text>}
						</Each>
						<View class="gap-1">
							<Text class="text-xs text-faint">Source and provenance</Text>
							<Each of={detail()?.provenance ?? []} key={(line) => line}>
								{(line) => <Text class="text-xs text-muted-foreground">{line()}</Text>}
							</Each>
						</View>
					</If>
					<View class="flex-row gap-2">
						<Action label="Back to map" onPress={close} />
						<Action label="Read source again" onPress={() => void load()} disabled={busy()} />
					</View>
				</View>
			</If>
		</View>
	);
}
