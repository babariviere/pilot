// Verify Sparkle's Ed25519 signature against the public key embedded in the bundle.
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [archive, publicKey, signature] = process.argv.slice(2);
const rawKey = Buffer.from(publicKey ?? "", "base64");
const rawSignature = Buffer.from(signature ?? "", "base64");
if (!archive || rawKey.length !== 32 || rawSignature.length !== 64) {
	throw new Error("Usage: verify-update.mjs archive public-key-base64 signature-base64");
}
const key = createPublicKey({
	key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
	format: "der",
	type: "spki",
});
if (!verify(null, readFileSync(archive), key, rawSignature)) {
	throw new Error("Sparkle signature does not match the bundled SUPublicEDKey");
}
