// Mock data. Font probe: does NSH draw the bundled Geist and Geist Mono faces?
import { mount, Text, View } from "nsh";
import "./fonts/Geist-Bold.ttf";
import "./fonts/Geist-Medium.ttf";
import Geist from "./fonts/Geist-Regular.ttf";
import "./fonts/Geist-SemiBold.ttf";
import "./fonts/GeistMono-Medium.ttf";
import GeistMono from "./fonts/GeistMono-Regular.ttf";
import "./fonts/GeistMono-SemiBold.ttf";

const WEIGHTS = [400, 500, 600, 700] as const;
const LINE = "One check failed. One push is unconfirmed. Rag 0123";

mount(() => (
	<View testID="font-probe" class="flex-1 gap-2 bg-background p-6">
		<Text testID="families" class="text-xs text-muted-foreground">{`Families: ${Geist} / ${GeistMono}`}</Text>
		<Each of={[...WEIGHTS]} key={(w) => String(w)}>
			{(w) => (
				<Text
					testID={`geist-${w()}`}
					class="text-foreground"
					style={{ fontFamily: Geist, fontSize: 22, fontWeight: w() }}
				>
					{`${w()} ${LINE}`}
				</Text>
			)}
		</Each>
		<Each of={[...WEIGHTS]} key={(w) => String(w)}>
			{(w) => (
				<Text testID={`system-${w()}`} class="text-muted-foreground" style={{ fontSize: 22, fontWeight: w() }}>
					{`${w()} ${LINE}`}
				</Text>
			)}
		</Each>
		<Text testID="mono" class="text-foreground" style={{ fontFamily: GeistMono, fontSize: 13 }}>
			Geist Mono 16:48 · 4/7 · e93b1a0 ⌘K ↩
		</Text>
		<Text testID="mono-600" class="text-foreground" style={{ fontFamily: GeistMono, fontSize: 13, fontWeight: 600 }}>
			Geist Mono 16:48 · 4/7 · e93b1a0 ⌘K ↩
		</Text>
		<Text testID="system-mono" class="font-mono text-muted-foreground" style={{ fontSize: 13 }}>
			System mono 16:48 · 4/7 · e93b1a0 ⌘K ↩
		</Text>
		<Text testID="small" class="text-foreground" style={{ fontFamily: Geist, fontSize: 13 }}>
			13 px body: Faster search stopped on 2 Linux test failures and needs a choice.
		</Text>
	</View>
));
