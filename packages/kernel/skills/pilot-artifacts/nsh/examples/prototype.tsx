// A prototype: clearly different variants of one screen, inside a realistic copy of the screen around it, tried in
// a few situations. Copy this file, then replace the variants, situations, mock data and screens.
// - The bar on top switches variant and situation. Its note says what the shown variant changes.
// - Only the shown variant is drawn, so a large mock stays small.
// - Switching resets the case's local state, so each combination starts the same way.
// - Nothing is saved or sent: pressing things changes only this preview.
import { signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Card, Choices, Page } from "pilot-artifact/ui";

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
		<Page title="Sync error: 3 variants" subtitle="Preview only. Buttons change only this preview; nothing is sent.">
			<View class="gap-2">
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
				<Text class="text-xs text-muted-foreground">{note()}</Text>
			</View>
			{/* The realistic screen around the variant: a desktop window. */}
			<View class="w-full max-w-3xl self-center rounded-xl border border-border bg-background">
				<View class="flex-row items-center border-b border-border px-4 py-2">
					<Text class="text-sm font-semibold text-foreground">Files</Text>
				</View>
				<Each of={[variant()]} key={(v) => v}>
					{(v) => (
						<Screen variant={v()} situation={situation()} pressed={pressed()} onRetry={() => pressed.set(true)} />
					)}
				</Each>
			</View>
		</Page>
	);
}

/** One variant of the screen, in one situation. */
function Screen(props: { variant: Variant; situation: Situation; pressed: boolean; onRetry: () => void }) {
	const c = () => CASES[props.situation];
	const failure = () => (
		<View class="gap-2">
			<Text class="text-sm font-medium text-foreground">Sync failed</Text>
			<Text class="text-sm text-muted-foreground">{props.pressed ? c().after : c().detail}</Text>
			<If when={!props.pressed}>
				<Button
					onPress={props.onRetry}
					class="self-start rounded-md border border-border px-3 py-1.5 hover:bg-accent"
				>
					<Text class="text-sm text-foreground">Try again</Text>
				</Button>
			</If>
		</View>
	);
	const list = (failed: number) => (
		<View>
			<Each of={FILES} key="index">
				{(name, i) => (
					<View class="gap-2 border-b border-border px-4 py-3">
						<View class="flex-row items-center justify-between">
							<Text class="text-sm text-foreground">{name()}</Text>
							<Text class="text-xs text-muted-foreground">{i() === failed ? "Not synced" : "Synced 08:40"}</Text>
						</View>
						<If when={props.variant === "inline" && i() === failed}>{failure()}</If>
					</View>
				)}
			</Each>
		</View>
	);
	return (
		<View class={props.variant === "panel" ? "flex-row" : ""}>
			<If when={props.variant === "banner"}>
				<View class="border-b border-border bg-muted p-4">{failure()}</View>
			</If>
			<View class="flex-1">{list(1)}</View>
			<If when={props.variant === "panel"}>
				<Card class="m-3 w-64" title="Payroll export">
					{failure()}
				</Card>
			</If>
		</View>
	);
}
