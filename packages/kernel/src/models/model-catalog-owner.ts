/** One scheduler per native runtime, including SDK-triggered extension registration refreshes. */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Runtime = Pick<ModelRuntime, "refresh" | "getAvailable">;
type CredentialMutations = Pick<ModelRuntime, "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey">;

export function ownModelCatalog(runtime: Runtime & Partial<CredentialMutations>): void {
	const refresh = runtime.refresh.bind(runtime);
	const getAvailable = runtime.getAvailable.bind(runtime);
	let tail = Promise.resolve();
	let queuedOffline: ReturnType<Runtime["refresh"]> | undefined;
	let availability: ReturnType<Runtime["getAvailable"]> | undefined;

	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const operation = tail.then(work);
		tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}
	function mutation<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) {
		return (...args: Args) => {
			availability = undefined;
			return work(...args).finally(() => {
				availability = undefined;
			});
		};
	}
	// Credential exchanges keep their SDK locking/cancellation, outside the catalog lane.
	// A reader after login/logout must not join a pass that inspected earlier credentials.
	if (runtime.login) runtime.login = mutation(runtime.login.bind(runtime));
	if (runtime.logout) runtime.logout = mutation(runtime.logout.bind(runtime));
	if (runtime.setRuntimeApiKey) runtime.setRuntimeApiKey = mutation(runtime.setRuntimeApiKey.bind(runtime));
	if (runtime.removeRuntimeApiKey) runtime.removeRuntimeApiKey = mutation(runtime.removeRuntimeApiKey.bind(runtime));

	runtime.refresh = (options = {}) => {
		// A registration mutates providers synchronously before requesting this refresh.
		// Never let subsequent readers join an availability pass from before that mutation.
		availability = undefined;
		const offline = options.allowNetwork === false && !options.providers && !options.force && !options.signal;
		if (offline && queuedOffline) return queuedOffline;
		if (!offline) queuedOffline = undefined;
		const operation = enqueue(() => {
			// Registrations during an active refresh need one trailing pass, not its old result.
			if (queuedOffline === operation) queuedOffline = undefined;
			return refresh(options);
		});
		if (offline) queuedOffline = operation;
		return operation;
	};
	runtime.getAvailable = (provider, options) => {
		if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
		if (provider) return getAvailable(provider, options);
		if (!availability) {
			queuedOffline = undefined;
			// No caller owns cancellation of a shared catalog pass. Credentials are never cached here.
			const operation = enqueue(() => getAvailable());
			availability = operation;
			const clear = () => {
				if (availability === operation) availability = undefined;
			};
			void operation.then(clear, clear);
		}
		return withSignal(availability, options?.signal).then((models) => [...models]);
	};
}

function withSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
