// A separate, offline development entry. Never imports Connected or selects a profile.
import { mount, Text, View } from "nsh";
import { DayScreen } from "./DayScreen";
import { previewSource } from "./previewBuild";
import { keepPreviewDrafts, previewReady, previewSaveError } from "./previewState";
import { changes, day, plans, update } from "./session";

mount(() => {
	keepPreviewDrafts(day, plans);
	return (
		<View class="flex-1 bg-background">
			<View selectable testID="preview-label" class="gap-1 border-b border-border px-6 py-3">
				<Text class="text-sm font-medium text-foreground">Pilot Preview. Demo data, not your missions.</Text>
				<Text class="text-xs text-muted-foreground">{`Source ${previewSource}. No daemon or accounts connected.`}</Text>
				<Text class="text-xs text-muted-foreground">
					Demo actions reset on reopen. Draft text stays on this Mac.
				</Text>
				<If when={previewSaveError()}>
					<Text class="text-xs text-needs-ink">{previewSaveError()}</Text>
				</If>
			</View>
			<If when={previewReady()}>
				<DayScreen day={day} plans={plans} changes={changes} update={update} />
			</If>
		</View>
	);
});
