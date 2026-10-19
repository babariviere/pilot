/** Install a daemon-committed publish ceiling only at a verified fresh-run prompt boundary. */
import type { Storage } from "@earendil-works/pi-durable";
import type { ControlPermission } from "./tool-policy.ts";
import { turnPreparation } from "./turn-preparation.ts";

export function controlPermissionPreparation(
	storage: Pick<Storage, "submission" | "scanEntries">,
	permission: ControlPermission | undefined,
	prepare?: () => Promise<ControlPermission | undefined>,
	applied: (permission: ControlPermission) => void = () => {},
) {
	return turnPreparation(
		storage,
		async () => {
			const next = await prepare!();
			if (!permission || !next || permission.level !== "implement" || next.level !== "publish") return;
			// The same object is shared by Harness and native policy closures, never replaced mid-run.
			Object.assign(permission, next);
			applied(permission);
		},
		() => permission?.level === "implement" && !!prepare,
	);
}
