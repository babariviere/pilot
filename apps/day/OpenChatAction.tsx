// The same navigation affordance everywhere a screen offers an existing chat.

import type { ViewRef } from "nsh";
import { Action } from "./ui";

export function OpenChatAction(props: {
	accessibilityLabel: string;
	testID?: string;
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
}) {
	return (
		<Action
			label="Open chat"
			icon="chat"
			iconOnly
			anchor={(node) => props.anchor?.(node)}
			accessibilityLabel={props.accessibilityLabel}
			testID={props.testID}
			onPress={props.onPress}
		/>
	);
}
