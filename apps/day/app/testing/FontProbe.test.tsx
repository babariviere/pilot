// Mock data, native visual evidence only. Run with --target macos.
import { open, test } from "nsh/test";

test("bundled Geist faces draw in light and dark", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const app = await open("../../FontProbeFixture.tsx", { platform: "macos", width: 900, height: 420, colorScheme });
		await app.waitFor("id:font-probe");
		await app.wait(300);
		await app.screenshot(`output/font-probe-${colorScheme}.png`);
	}
});
