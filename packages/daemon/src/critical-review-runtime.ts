/** Fake-provider qualification seam only. No native Build/Ask factory or model/auth adapter.
 * Production entry points remain disabled until acquisition, consent and runtime integration qualify.
 */
import { RestrictedReviewBoundary, type ReviewReadPort, reviewAbortable } from "@pilot/kernel/review-boundary";
import type { ReviewAccounting, ReviewCallRequest, ReviewProviderGates } from "./critical-review-accounting.ts";
import type { CriticalReviewVault } from "./critical-review-vault.ts";

export function sealedReviewPort(vault: CriticalReviewVault, manifestId: string): ReviewReadPort {
	return Object.freeze({
		async list(cursor: number, limit: number, signal: AbortSignal) {
			signal.throwIfAborted();
			const manifest = await vault.manifest(manifestId);
			const entries = manifest.entries.slice(cursor, cursor + limit);
			return {
				manifestId,
				entries,
				complete: manifest.complete,
				omitted: manifest.omissions.length,
				...(cursor + entries.length < manifest.entries.length ? { next: cursor + entries.length } : {}),
			};
		},
		async read(blobId: string, offset: number, limit: number, signal: AbortSignal) {
			signal.throwIfAborted();
			const page = await vault.read(manifestId, blobId, offset, limit);
			signal.throwIfAborted();
			return { manifestId, blobId, offset, ...page, trust: "untrusted_evidence" };
		},
		async search(blobId: string, query: string, offset: number, signal: AbortSignal) {
			signal.throwIfAborted();
			const page = await vault.read(manifestId, blobId, offset, 49 * 1024);
			signal.throwIfAborted();
			const matches: number[] = [];
			let from = 0;
			while (matches.length < 50) {
				const index = page.text.indexOf(query, from);
				if (index === -1) break;
				matches.push(offset + Buffer.byteLength(page.text.slice(0, index)));
				from = index + query.length;
			}
			const points = Array.from(query).length;
			const overlap =
				points > 1
					? Array.from(page.text)
							.slice(-(points - 1))
							.join("")
					: "";
			const next =
				matches.length === 50
					? offset + Buffer.byteLength(page.text.slice(0, from))
					: page.next !== undefined
						? page.next - Buffer.byteLength(overlap)
						: undefined;
			return {
				manifestId,
				blobId,
				matches,
				...(next !== undefined ? { next } : {}),
				limited: true,
			};
		},
	});
}
export interface SyntheticReviewProvider {
	kind: "synthetic";
	step(input: {
		systemPrompt: string;
		tools: RestrictedReviewBoundary["tools"];
		messages: readonly unknown[];
		maxInputTokens: number;
		maxGeneratedTokens: number;
		signal: AbortSignal;
	}): Promise<{
		text?: string;
		toolCalls?: Array<{ name: string; args: unknown }>;
		usage?: { inputTokens: number; generatedTokens: number; durationMs: number };
	}>;
}
/** Fresh bounded context; follow-ups reuse exactly the same capabilities and accounting envelope. */
export class SyntheticReviewer {
	#boundary: RestrictedReviewBoundary;
	#accounting: ReviewAccounting;
	#runId: string;
	#messages: unknown[] = [];
	#busy = false;
	#closed = new AbortController();
	#steps = 0;
	#unsubscribe: () => void;
	constructor(port: ReviewReadPort, accounting: ReviewAccounting, runId: string) {
		this.#boundary = new RestrictedReviewBoundary(port);
		this.#accounting = accounting;
		this.#runId = runId;
		this.#unsubscribe = accounting.onPrivateInvalidation(() => this.close());
	}
	close(): void {
		this.#closed.abort();
		this.#boundary.close();
		this.#messages = [];
		this.#unsubscribe();
	}
	async turn(
		provider: SyntheticReviewProvider,
		text: string,
		request: ReviewCallRequest,
		gates: () => ReviewProviderGates,
		signal?: AbortSignal,
	): Promise<string> {
		if (
			provider.kind !== "synthetic" ||
			this.#busy ||
			this.#closed.signal.aborted ||
			request.runId !== this.#runId ||
			this.#steps >= 32 ||
			Buffer.byteLength(text) > 16 * 1024
		)
			throw new Error("Reviewer disabled or request denied");
		this.#busy = true;
		this.#steps++;
		const controller = new AbortController();
		const combined = AbortSignal.any([this.#closed.signal, controller.signal, ...(signal ? [signal] : [])]);
		let reserved = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			combined.throwIfAborted();
			this.#messages.push({ role: "user", text });
			if (Buffer.byteLength(JSON.stringify(this.#messages)) > 256 * 1024)
				throw new Error("Reviewer context ceiling reached");
			await this.#accounting.reserve({ ...request, gates: gates() });
			reserved = true;
			combined.throwIfAborted();
			await this.#accounting.send(request.callId, gates());
			combined.throwIfAborted();
			timer = setTimeout(() => controller.abort(), request.durationMs);
			const result = await reviewAbortable(
				provider.step({
					systemPrompt: this.#boundary.systemPrompt,
					tools: this.#boundary.tools,
					messages: structuredClone(this.#messages),
					maxInputTokens: request.inputTokens,
					maxGeneratedTokens: request.generatedTokens,
					signal: combined,
				}),
				combined,
			);
			await this.#accounting.settle(request.callId, result.usage);
			reserved = false;
			combined.throwIfAborted();
			if ((result.toolCalls?.length ?? 0) > 8 || Buffer.byteLength(JSON.stringify(result)) > 50 * 1024)
				throw new Error("Reviewer response ceiling reached");
			if (result.text) this.#messages.push({ role: "assistant", text: result.text });
			for (const call of result.toolCalls ?? []) {
				let value: unknown;
				try {
					value = await this.#boundary.execute(call.name, call.args, combined);
				} catch {
					value = { error: "Tool unavailable or denied" };
				}
				this.#messages.push({ role: "tool", name: call.name, value });
			}
			combined.throwIfAborted();
			return result.text ?? "";
		} catch (error) {
			this.close();
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			try {
				if (reserved) await this.#accounting.settle(request.callId);
			} finally {
				this.#busy = false;
			}
		}
	}
}
