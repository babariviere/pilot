/** Local, opt-in full-package metadata. Uses the existing approved key, never creates trust. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assets, envelope, metadata } from "./gui-release-manifest.mjs";

export function iterationManifest(record, archive, source, privateKey, publicKey) {
	const value = metadata(record, archive, record.platform, 1, source, `v${record.version}`);
	// Unlike legacy macOS release envelopes, local iteration always signs its exact source.
	value.source = source;
	return {
		pin: `${JSON.stringify({ schema: 1, source, archive_asset_id: 1 })}\n`,
		signed: envelope(value, privateKey, publicKey),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [directory, source] = process.argv.slice(2);
	if (!directory || !source || process.argv.length !== 4)
		throw new Error("Expected staged package directory and full source commit");
	const record = JSON.parse(readFileSync(join(directory, "gui-release-artifact.json")));
	const names = assets[record.platform];
	if (!names) throw new Error("Unsupported local package platform");
	const result = iterationManifest(
		record,
		readFileSync(join(directory, names[0])),
		source,
		process.env.PILOT_NEXT_UPDATER_PRIVATE_KEY,
		process.env.PILOT_NEXT_UPDATER_PUBLIC_KEY,
	);
	writeFileSync(join(directory, names[1]), result.signed, { flag: "wx", mode: 0o600 });
	// Publish readiness last. The app copies/authenticates immutable bytes privately.
	writeFileSync(join(directory, "iteration.json"), result.pin, { flag: "wx", mode: 0o600 });
}
