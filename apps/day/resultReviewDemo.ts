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
