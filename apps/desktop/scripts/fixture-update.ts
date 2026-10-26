/** Synthetic public configuration and signed metadata only. Never production keys/feed/upload. */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const APPLICATION = "com.example.synthetic.next";
export function fixtureEnvelope(archive: Buffer, build: string, version: string) {
	if (!/^\d{1,9}(?:\.\d{1,9}){0,3}$/.test(build) || !/^\d+\.\d+\.\d+$/.test(version))
		throw new Error("Invalid synthetic version");
	// Deliberately public, deterministic TEST seed. Never use this key for distribution.
	const key = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 42)]),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
	const signed = Buffer.from(
		JSON.stringify({
			schema: 1,
			application_id: APPLICATION,
			channel: "desktop-stable",
			platform: "macos",
			architecture: "aarch64",
			build,
			short_version: version,
			bundle_name: "Pilot Next.app",
			archive_name: "Pilot-Next-macos-arm64.zip",
			archive_asset_id: 12,
			archive_size: archive.length,
			archive_sha256: createHash("sha256").update(archive).digest("hex"),
		}),
	);
	return {
		envelope: { signed: signed.toString("base64"), signature: sign(null, signed, key).toString("base64") },
		publicKey,
	};
}
async function main(args: string[]) {
	if (args.length !== 5 || args[0] !== "--fixture-only")
		throw new Error("Use --fixture-only ARCHIVE OUTPUT_DIR BUILD SHORT_VERSION");
	const archivePath = await realpath(resolve(args[1]!));
	const output = await realpath(resolve(args[2]!));
	const temporary = await realpath(tmpdir());
	if (!output.startsWith(temporary + sep) || !archivePath.startsWith(output + sep))
		throw new Error("Fixture files must stay inside a private temporary output directory");
	const directory = await lstat(output);
	if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
		throw new Error("Private owned fixture directory required");
	const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > 1024 ** 3)
			throw new Error("Fixture archive exceeds policy");
		const result = fixtureEnvelope(await handle.readFile(), args[3]!, args[4]!);
		await writeFile(resolve(output, "desktop-macos-arm64-update.json"), `${JSON.stringify(result.envelope)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await writeFile(
			resolve(output, "fixture-public-configuration.json"),
			`${JSON.stringify(
				{
					fixtureOnly: true,
					applicationId: APPLICATION,
					publicKey: result.publicKey,
					repository: "synthetic/fixture-only",
					codeRequirement: `identifier "${APPLICATION}"`,
					productionUse: false,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
	} finally {
		await handle.close();
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch(() => {
		console.error("Synthetic update fixture creation failed. No production configuration was changed.");
		process.exitCode = 1;
	});
}
