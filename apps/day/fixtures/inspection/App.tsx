import { mount, signal, View } from "nsh";
import { InspectInWindow } from "../../InspectionWindow";
import { TextField } from "../../ui/field";

mount(() => {
	const draft = signal("");
	return (
		<View class="flex-1 bg-background p-4">
			<TextField
				testID="draft"
				accessibilityLabel="Draft"
				value={draft()}
				onChange={({ value }) => draft.set(value)}
			/>
			<InspectInWindow title="Export comparison" context="Harbor · Revision 3" text="Before: B, A. After: A, B." />
		</View>
	);
});
