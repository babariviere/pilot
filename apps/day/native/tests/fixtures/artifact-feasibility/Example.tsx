// Behavioral fixture, not a production viewer or an approved comparison schema.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

function Example() {
	const alternative = signal("Outline");
	const count = signal(0);
	return (
		<View class="p-4 gap-4 bg-background">
			<Text class="text-foreground">Local preview only</Text>
			<Button onPress={() => alternative.set(alternative() === "Outline" ? "Map" : "Outline")}>
				<Text>Compare</Text>
			</Button>
			<Text>{alternative()}</Text>
			<Button onPress={() => count.set(count() + 1)}>
				<Text>Try</Text>
			</Button>
			<Text>{`Count: ${count()}`}</Text>
		</View>
	);
}

mount(Example);
