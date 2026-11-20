import { resolve } from "node:path";

/** Pilot.app keeps the daemon source under Contents/Resources/runtime/ and its helpers under Contents/Helpers/. */
export function appBundleHelper(source: string, name: string): string | undefined {
	const runtime = "/Contents/Resources/runtime/";
	if (source.includes(runtime)) return resolve(source.split(runtime)[0]!, "Contents/Helpers", name);
}
