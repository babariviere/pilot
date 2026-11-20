// A prototype: clearly different variants of one screen, inside a realistic copy of the screen around it, tried in
// a few situations. Copy this file, then replace the variants, situations, mock data and screens.
// - The bar on top switches variant and situation. Its note says what the shown variant changes.
// - Only the shown variant is drawn, so a large mock stays small.
// - Switching resets the case's local state, so each combination starts the same way.
// - Nothing is saved or sent: pressing things changes only this preview.
// - The screen is built from Pilot's own parts (`pilot-day/ui`), so it looks like the app.
import { Scroll, signal, View } from "nsh";
import { Choices } from "pilot-artifact/ui";
import {
	Block,
	Body,
	Button,
	Caption,
	Column,
	Columns,
	Notice,
	Num,
	Page,
	PageHead,
	Panel,
	Row,
	RowDetail,
	Rows,
	Section,
} from "pilot-day/ui";

type Variant = "banner" | "inline" | "panel";
type Situation = "first" | "again" | "fixed";

const VARIANTS = [
	{ id: "banner", label: "A · Banner on top", note: "A: one banner above the list. The list stays as it was." },
	{ id: "inline", label: "B · Inline row", note: "B: the failed row opens in place with what happened." },
	{ id: "panel", label: "C · Side panel", note: "C: a panel beside the list holds the details and the action." },
] as const;

const SITUATIONS = [
	{ id: "first", label: "1 · First failure" },
	{ id: "again", label: "2 · Failed again" },
	{ id: "fixed", label: "3 · Works when pressed" },
] as const;

/** What each situation shows before and after Try again is pressed. Real words, times and counts. */
const CASES: Record<Situation, { detail: string; after: string }> = {
	first: {
		detail: "The server answered 503 at 09:12. Nothing was changed.",
		after: "Failed again at 09:14. Your files are as they were.",
	},
	again: {
		detail: "Third failure since 08:50. The server is down for maintenance until 10:00.",
		after: "Failed again at 09:14. Try after 10:00, or contact support.",
	},
	fixed: {
		detail: "The server answered 503 at 09:12. Nothing was changed.",
		after: "Synced at 09:14. 4 files are up to date.",
	},
};

const FILES = ["Invoices · March", "Payroll export", "Supplier list", "Expense reports"];
const FAILED = 1;

export default function Artifact() {
	const variant = signal<Variant>("banner");
	const situation = signal<Situation>("first");
	// The case's local state: whether Try again was pressed. Switching starts the case over.
	const pressed = signal(false);
	const choose = (set: () => void) => {
		set();
		pressed.set(false);
	};
	const note = () => VARIANTS.find((v) => v.id === variant())?.note ?? "";
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead
					title="Sync error: 3 variants"
					text="Preview only. Buttons change only this preview; nothing is sent."
				>
					<View class="gap-2 pt-2">
						<Choices
							label="Variant"
							options={VARIANTS}
							value={variant()}
							onChange={(id) => choose(() => variant.set(id))}
						/>
						<Choices
							label="Situation"
							options={SITUATIONS}
							value={situation()}
							onChange={(id) => choose(() => situation.set(id))}
						/>
						<Caption>{note()}</Caption>
					</View>
				</PageHead>
				{/* The realistic screen around the variant. */}
				<Each of={[variant()]} key={(v) => v}>
					{(v) => (
						<Screen variant={v()} situation={situation()} pressed={pressed()} onRetry={() => pressed.set(true)} />
					)}
				</Each>
			</Page>
		</Scroll>
	);
}

/** One variant of the screen, in one situation. */
function Screen(props: { variant: Variant; situation: Situation; pressed: boolean; onRetry: () => void }) {
	const words = () => (props.pressed ? CASES[props.situation].after : CASES[props.situation].detail);
	// Functions, so each place that shows them gets its own views.
	const retry = () => (
		<If when={!props.pressed}>
			<Button small label="Try again" onPress={props.onRetry} />
		</If>
	);
	const files = () => (
		<Section title="Files" count={FILES.length}>
			<Rows>
				<Each of={FILES} key={(name) => name}>
					{(name, i) => (
						<Row
							title={name()}
							mark={i() === FAILED ? "failed" : "done"}
							state={i() === FAILED ? "Not synced" : undefined}
							stateTone="failed"
							trailing={
								<If when={i() !== FAILED}>
									<Num>08:40</Num>
								</If>
							}
							detail={
								<If when={props.variant === "inline" && i() === FAILED}>
									<RowDetail>
										<Body tone="muted">{words()}</Body>
										<View class="flex-row">{retry()}</View>
									</RowDetail>
								</If>
							}
						/>
					)}
				</Each>
			</Rows>
		</Section>
	);
	return (
		<Panel
			notice={
				<If when={props.variant === "banner"}>
					<Notice kind="failed" text="Sync failed" detail={words()} action={retry()} placement="panel" />
				</If>
			}
		>
			<If when={props.variant === "panel"} else={<Column>{files()}</Column>}>
				<Columns
					main={files()}
					side={
						<Section title="Payroll export">
							<Block>
								<Body>Sync failed</Body>
								<Body tone="muted">{words()}</Body>
								<View class="flex-row">{retry()}</View>
							</Block>
						</Section>
					}
				/>
			</If>
		</Panel>
	);
}
