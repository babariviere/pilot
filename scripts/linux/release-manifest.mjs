/** Signed byte-exact manifest. The verification key is shipped with the client, never trusted from assets. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_PROTOCOL_VERSION, MINIMUM_CLIENT_PROTOCOL_VERSION } from "../../packages/protocol/src/hello.ts";

export const archiveName = "Pilot-linux-x64.tar.gz";
export const manifestName = "runtime-manifest.json";
export function validateManifest(value) {
	if (
		value.schemaVersion !== 1 ||
		value.platform !== "linux" ||
		value.arch !== "x64" ||
		!/^\d+\.\d+\.\d+$/.test(value.version) ||
		value.tag !== `v${value.version}` ||
		!/^[a-f0-9]{40}$/.test(value.commit)
	)
		throw new Error("Invalid Linux runtime manifest identity");
	if (
		value.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
		!Number.isSafeInteger(value.minimumClientProtocolVersion) ||
		value.minimumClientProtocolVersion < 1 ||
		value.minimumClientProtocolVersion > value.protocolVersion
	)
		throw new Error("Incompatible Linux runtime protocol");
	if (
		value.archive.name !== archiveName ||
		!/^[a-f0-9]{64}$/.test(value.archive.sha256) ||
		!Number.isSafeInteger(value.archive.size) ||
		value.archive.size <= 0
	)
		throw new Error("Invalid Linux runtime archive");
	if (
		!/^24\.\d+\.\d+$/.test(value.node.version) ||
		!/^\d+$/.test(value.node.modules) ||
		!/^2\.\d+$/.test(value.minimumGlibc)
	)
		throw new Error("Invalid Linux runtime ABI");
	return value;
}

export function authenticateManifest(bytes, signature, publicKey) {
	if (bytes.length > 64 * 1024 || signature.length !== 64 || !verify(null, bytes, publicKey, signature))
		throw new Error("Invalid Linux runtime signature");
	return validateManifest(JSON.parse(bytes));
}

export function authenticateArchive(manifest, archive) {
	if (
		archive.length !== manifest.archive.size ||
		createHash("sha256").update(archive).digest("hex") !== manifest.archive.sha256
	)
		throw new Error("Linux runtime archive checksum mismatch");
}

function main() {
	const [action, output, root] = process.argv.slice(2);
	if (action === "create") {
		const release = JSON.parse(readFileSync(join(root, "package.json")));
		const abi = JSON.parse(readFileSync(join(root, "runtime-abi.json")));
		const archive = readFileSync(join(output, archiveName));
		const manifest = validateManifest({
			schemaVersion: 1,
			platform: "linux",
			arch: "x64",
			version: release.version,
			tag: `v${release.version}`,
			commit: process.env.PILOT_RELEASE_COMMIT,
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			minimumClientProtocolVersion: MINIMUM_CLIENT_PROTOCOL_VERSION,
			minimumGlibc: abi.minimumGlibc,
			minimumGlibcxx: abi.minimumGlibcxx,
			node: { version: process.versions.node, modules: process.versions.modules },
			archive: {
				name: archiveName,
				size: archive.length,
				sha256: createHash("sha256").update(archive).digest("hex"),
			},
		});
		writeFileSync(join(output, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
	} else if (action === "sign") {
		const bytes = readFileSync(join(output, manifestName));
		validateManifest(JSON.parse(bytes));
		const key = createPrivateKey(process.env.LINUX_RUNTIME_PRIVATE_KEY ?? "");
		if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 release key required");
		const expected = Buffer.from(process.env.LINUX_RUNTIME_PUBLIC_KEY ?? "", "base64");
		const actual = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
		if (expected.length !== 32 || !actual.equals(expected))
			throw new Error("Private release key does not match pinned public key");
		const signature = sign(null, bytes, key);
		authenticateManifest(bytes, signature, createPublicKey(key));
		authenticateArchive(JSON.parse(bytes), readFileSync(join(output, archiveName)));
		writeFileSync(join(output, `${manifestName}.sig`), `${signature.toString("base64")}\n`);
	} else throw new Error("Usage: release-manifest.mjs create|sign output-directory [runtime]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
