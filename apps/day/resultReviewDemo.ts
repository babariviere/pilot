// Capture fixture data only. Uses the production result page and review panel.
import type { ResultReviewEntry, ResultReviewSource } from "./resultReview";

export function resultReviewDemo(): ResultReviewSource {
	const comments: ResultReviewEntry[] = [];
	return {
		async read(work) {
			if (!comments.length)
				comments.push({
					subject: work.subject,
					operationId: "keyboard-comment",
					deliveryId: work.deliveryId!,
					expectedRevision: 0,
					revision: 1,
					kind: "comment",
					body: "Please check canceling from the keyboard too.",
					ownerSessionId: work.ownerSessionId,
					at: 1,
					anchor: {
						kind: "lines",
						snapshotId: "export-comparison",
						side: "after",
						path: "src/export.ts",
						start: 3,
						end: 3,
						blobSha256: "c".repeat(64),
						excerpt: "  if (!path) return;",
					},
				});
			return {
				data: {
					subject: work.subject,
					deliveryId: work.deliveryId!,
					revision: comments.length,
					entries: [...comments],
					snapshots: ["export-comparison"],
				},
				pending: [],
			};
		},
		async diff() {
			return {
				snapshotId: "export-comparison",
				base: "8ac2d10",
				head: "c94fa21",
				status: "complete",
				omissions: [],
				files: [
					{
						path: "src/export.ts",
						status: "modified",
						reason: "",
						before: {
							path: "src/export.ts",
							sha256: "b".repeat(64),
							text: "async function exportReport() {\n  const path = await chooseSavePath();\n  clearDraft();\n  await writeReport(path);\n}\n",
						},
						after: {
							path: "src/export.ts",
							sha256: "c".repeat(64),
							text: "async function exportReport() {\n  const path = await chooseSavePath();\n  if (!path) return;\n  await writeReport(path);\n  clearDraft();\n}\n",
						},
					},
					{
						path: "src/history/loader.ts",
						status: "modified",
						reason: "",
						before: {
							path: "src/history/loader.ts",
							sha256: "d".repeat(64),
							text: "export async function loadHistory(chat: string) {\n  const page = await fetchPage(chat, 0);\n  return page.messages;\n}\n",
						},
						after: {
							path: "src/history/loader.ts",
							sha256: "e".repeat(64),
							text: "const PAGE = 50;\n\n/** Older messages, 50 at a time, while a reply streams. */\nexport async function loadHistory(chat: string, before?: string) {\n  const page = await fetchPage(chat, { before, limit: PAGE });\n  keepScrollAnchor(page.first);\n  return page.messages;\n}\n",
						},
					},
					{
						path: "src/history/loader.test.ts",
						status: "modified",
						reason: "",
						before: {
							path: "src/history/loader.test.ts",
							sha256: "f".repeat(64),
							text: "test('loads history', async () => {\n  expect(await loadHistory('c1')).toHaveLength(20);\n});\n",
						},
						after: {
							path: "src/history/loader.test.ts",
							sha256: "0".repeat(64),
							text: "test('loads history', async () => {\n  expect(await loadHistory('c1')).toHaveLength(50);\n});\n\ntest('loads older messages while a reply streams', async () => {\n  stream('c1');\n  expect(await loadHistory('c1', 'm50')).toHaveLength(50);\n});\n",
						},
					},
				],
			};
		},
		async save(work, edit) {
			const receipt = {
				...edit,
				operationId: crypto.randomUUID(),
				subject: work.subject,
				revision: comments.length + 1,
				ownerSessionId: work.ownerSessionId,
				at: 2,
			};
			comments.push(receipt);
			return { state: "saved", operationId: receipt.operationId, receipt };
		},
		async check(id) {
			return { state: "saved", operationId: id, receipt: comments.find((e) => e.operationId === id) ?? null };
		},
	};
}
