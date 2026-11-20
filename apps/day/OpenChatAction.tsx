// The same navigation affordance everywhere a screen offers an existing chat.

import type { ViewRef } from "nsh";
import { Button } from "./ui";

export function OpenChatAction(props: {
	accessibilityLabel: string;
	/** Visible words when the surrounding row does not name the chat. Omit for a named chat row. */
	label?: string;
	testID?: string;
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
}) {
	return (
		<Button
			small
			label={props.label ?? "Open chat"}
			icon="chat"
			iconOnly={props.label === undefined}
			anchor={(node) => props.anchor?.(node)}
			accessibilityLabel={props.accessibilityLabel}
			testID={props.testID}
			onPress={props.onPress}
		/>
	);
}
