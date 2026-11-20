import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveredArtifact, DeliveredArtifactRequest, DeliveredWork, DeliveredWorkList } from "@pilot/protocol";
import type { ArtifactSelection, CapturedArtifact } from "../../../apps/day/deliveryArtifactContract.ts";
import type { DeliveryList, DeliveredWork as NativeView } from "../../../apps/day/deliveryContract.ts";

// These assignments are checked by tsgo without loading NSH or its platform VM.
// Day's display projection can be narrower than the canonical wire data.
const view: (v: DeliveredWork) => NativeView = (v) => v;
type Fields = Exclude<keyof DeliveredWork, "pullRequests" | "artifacts">;
const canonicalFields: (v: NativeView) => Pick<DeliveredWork, Fields> = (v) => v;
const list: (v: DeliveredWorkList) => DeliveryList = (v) => v;
const listFields: (v: DeliveryList) => Omit<DeliveredWorkList, "items" | "selected"> = (v) => v;

test("Day wire view accepts canonical delivery and assessment fields", () => {
	// Keep the projection signatures referenced without inventing domain fixtures.
	assert.equal(typeof view, "function");
	assert.equal(typeof canonicalFields, "function");
	assert.equal(typeof list, "function");
	assert.equal(typeof listFields, "function");
});

const artifactSelectionCompatible: (v: ArtifactSelection) => DeliveredArtifactRequest = (v) => v;
const capturedArtifactCompatible: (v: DeliveredArtifact) => CapturedArtifact = (v) => v;
void artifactSelectionCompatible;
void capturedArtifactCompatible;
