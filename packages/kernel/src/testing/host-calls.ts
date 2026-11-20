/** A fake pilotd for kernel tests: answers only the host calls a test gives, and refuses any other. */
import type { HostCall, HostCalls, HostMethod } from "../worker/protocol.ts";

export type HostCallFakes = {
	[M in HostMethod]?: (
		args: HostCalls[M]["args"],
		signal?: AbortSignal,
	) => Promise<HostCalls[M]["result"]> | HostCalls[M]["result"];
};

export function fakeHostCall(fakes: HostCallFakes): HostCall {
	return async (method, args, signal) => {
		const fake = fakes[method] as
			| ((args: unknown, signal?: AbortSignal) => Promise<HostCalls[typeof method]["result"]>)
			| undefined;
		if (!fake) throw new Error(`The test pilotd has no ${method} host call`);
		return fake(args, signal);
	};
}
