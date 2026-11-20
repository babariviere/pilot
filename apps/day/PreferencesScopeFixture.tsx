// The real Settings screen and preference feed, with every host reply supplied by the test.
import { mount, signal, View } from "nsh";
import { MockDayScreen, openDay } from "./mockFeeds";
import { connectedPreferences } from "./preferencesFeed";
import { Button } from "./ui";

const preferences = connectedPreferences("fixture");
const atlas = preferences.scope.project("a");
const history = atlas.source.history.bind(atlas.source);
const release = signal<(() => void) | null>(null);
// The host mock must reply immediately so the test runner can drive another
// step. Hold the already-read page inside the app instead.
atlas.source.history = async (before) => {
	const page = await history(before);
	await new Promise<void>((resolve) => release.set(resolve));
	return page;
};
const day = { ...openDay(), preferences };
mount(() => (
	<View class="flex-1">
		<If when={release()}>
			<Button
				label="Release Atlas history"
				testID="release-atlas-history"
				onPress={() => {
					release()?.();
					release.set(null);
				}}
			/>
		</If>
		<MockDayScreen day={day} />
	</View>
));
