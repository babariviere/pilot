/** Exact-byte GUI metadata signing, using Node's maintained Ed25519 implementation. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const assets = {
	macos: ["Pilot-Next-macos-arm64.zip", "desktop-macos-arm64-update.json"],
	linux: ["Pilot-Next-linux-x64.zip", "desktop-linux-x64-update.json"],
};

// Platforms a stable release publishes. Linux returns once its package policy
// qualifies bundled launch, installer and updater (see docs/releases.md).
export const releasePlatforms = ["macos"];

export function metadata(record, bytes, platform, assetId, source, tag) {
	const names = assets[platform];
	if (
		!names ||
		record.schema !== 1 ||
		record.platform !== platform ||
		record.source !== source ||
		!/^[0-9a-f]{40}$/.test(source) ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(record.version) ||
		tag !== `v${record.version}` ||
		record.archive !== names[0] ||
		!Number.isSafeInteger(assetId) ||
		assetId < 1 ||
		!/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,3}$/.test(record.build) ||
		record.bytes !== bytes.length ||
		bytes.length === 0 ||
		bytes.length > 1024 ** 3 ||
		record.sha256 !== createHash("sha256").update(bytes).digest("hex")
	)
		throw new Error("GUI source/tag/platform/build/archive identity mismatch");
	return {
		schema: 1,
		application_id: "com.babariviere.pilot-next",
		channel: "desktop-stable",
		platform,
		architecture: platform === "macos" ? "aarch64" : "x86_64",
		build: record.build,
		short_version: record.version,
		bundle_name: platform === "macos" ? "Pilot Next.app" : "Pilot Next",
		archive_name: names[0],
		archive_asset_id: assetId,
		archive_size: bytes.length,
		archive_sha256: record.sha256,
		...(platform === "linux" ? { source } : {}),
	};
}

function signingKey(privatePem, publicBase64) {
	const key = createPrivateKey(privatePem);
	if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 GUI release key required");
	const publicKey = createPublicKey(key);
	const expected = Buffer.from(publicBase64, "base64");
	if (expected.length !== 32 || !publicKey.export({ type: "spki", format: "der" }).subarray(-32).equals(expected))
		throw new Error("GUI private key does not match compiled trust key");
	return key;
}

export function envelope(value, privatePem, publicBase64) {
	const key = signingKey(privatePem, publicBase64);
	const signed = Buffer.from(JSON.stringify(value));
	const signature = sign(null, signed, key);
	if (!verify(null, signed, createPublicKey(key), signature)) throw new Error("GUI signature verification failed");
	return `${JSON.stringify({ signed: signed.toString("base64"), signature: signature.toString("base64") })}\n`;
}

export function sealLinux(directory, source, build, privatePem, publicBase64) {
	const bytes = readFileSync(join(directory, "linux-gui-package.json"));
	const value = JSON.parse(bytes);
	if (
		value.schema !== 1 ||
		value.kind !== "linux-gui-distribution" ||
		value.source !== source ||
		!/^[a-f0-9]{40}$/.test(source) ||
		value.bundle_build !== build ||
		value.application_id !== "com.babariviere.pilot-next" ||
		value.short_version !== value.build?.version ||
		value.native_visual_execution !== false ||
		["bundled_launch", "installer", "updater"].some((k) => value[k] !== true)
	)
		throw new Error("Linux production inventory identity/qualification mismatch");
	const key = signingKey(privatePem, publicBase64);
	const signature = sign(null, bytes, key);
	if (!verify(null, bytes, createPublicKey(key), signature)) throw new Error("Linux inventory signature failed");
	writeFileSync(join(directory, "linux-gui-package.sig"), signature.toString("base64"));
}

export function verifyRelease(release, envelopes, publicBase64, source, tag, platforms = releasePlatforms) {
	const raw = Buffer.from(publicBase64, "base64");
	if (raw.length !== 32) throw new Error("Missing pinned GUI release verification key");
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
		type: "spki",
		format: "der",
	});
	if (!release.draft || release.prerelease || release.tag_name !== tag)
		throw new Error("Expected matching stable draft");
	for (const platform of platforms) {
		const [archiveName, manifestName] = assets[platform];
		const selected = release.assets.filter((a) => a.name === archiveName && a.state === "uploaded");
		if (selected.length !== 1) throw new Error("Expected exactly one GUI archive");
		const archive = selected[0];
		const value = JSON.parse(envelopes[manifestName]);
		const signed = Buffer.from(value.signed, "base64");
		if (!verify(null, signed, key, Buffer.from(value.signature, "base64")))
			throw new Error("Invalid GUI release signature");
		const manifest = JSON.parse(signed);
		if (
			manifest.schema !== 1 ||
			manifest.application_id !== "com.babariviere.pilot-next" ||
			manifest.channel !== "desktop-stable" ||
			manifest.platform !== platform ||
			manifest.architecture !== (platform === "macos" ? "aarch64" : "x86_64") ||
			manifest.bundle_name !== (platform === "macos" ? "Pilot Next.app" : "Pilot Next") ||
			manifest.archive_name !== archiveName ||
			manifest.archive_asset_id !== archive.id ||
			manifest.archive_size !== archive.size ||
			`sha256:${manifest.archive_sha256}` !== archive.digest ||
			`v${manifest.short_version}` !== tag ||
			(platform === "linux" && manifest.source !== source)
		)
			throw new Error("GUI draft assets differ from authenticated update metadata");
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [platform, directory, id] = process.argv.slice(2);
	if (platform === "verify-release") {
		const envelopes = Object.fromEntries(
			releasePlatforms.map((platform) => [assets[platform][1], readFileSync(join(directory, assets[platform][1]))]),
		);
		verifyRelease(
			JSON.parse(readFileSync(join(directory, "release-api.json"))),
			envelopes,
			process.env.PILOT_NEXT_UPDATER_PUBLIC_KEY,
			process.env.RELEASE_SOURCE,
			process.env.RELEASE_TAG,
		);
	} else if (platform === "seal-linux") {
		sealLinux(
			directory,
			process.env.RELEASE_SOURCE,
			process.env.PILOT_NEXT_UPDATER_BUILD,
			process.env.PILOT_NEXT_UPDATER_PRIVATE_KEY,
			process.env.PILOT_NEXT_UPDATER_PUBLIC_KEY,
		);
	} else {
		if (!assets[platform]) throw new Error("Expected macos|linux and verified GUI artifact directory and asset ID");
		const record = JSON.parse(readFileSync(join(directory, "gui-release-artifact.json")));
		const archive = readFileSync(join(directory, assets[platform][0]));
		const value = metadata(
			record,
			archive,
			platform,
			Number(id),
			process.env.RELEASE_SOURCE,
			process.env.RELEASE_TAG,
		);
		writeFileSync(
			join(directory, assets[platform][1]),
			envelope(value, process.env.PILOT_NEXT_UPDATER_PRIVATE_KEY, process.env.PILOT_NEXT_UPDATER_PUBLIC_KEY),
		);
	}
}
