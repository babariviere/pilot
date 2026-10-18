/** Read-only, host-local file admission. File contents are data, never instructions. */
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const CONTROL_TEXT_BYTES = 64 * 1024;
export const CONTROL_IMAGE_BYTES = 8 * 1024 * 1024;
const images: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const texts = new Set([
	".txt",
	".md",
	".json",
	".jsonl",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".sh",
	".toml",
	".yaml",
	".yml",
	".log",
	".csv",
	".sql",
	".swift",
	".html",
	".css",
	".xml",
	".rs",
	".c",
	".h",
	".cpp",
	".go",
]);
const textNames = new Set([
	"README",
	"LICENSE",
	"NOTICE",
	"COPYING",
	"Makefile",
	"Dockerfile",
	"Justfile",
	".gitignore",
	".gitattributes",
	".editorconfig",
]);
function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function imageSignature(bytes: Buffer, mime: string): boolean {
	if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
	if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
	return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}
export interface ControlFileAudit {
	caller: string;
	path: string;
	bytes?: number;
	returnedBytes?: number;
	outcome: "read" | "denied";
}
export class ControlFiles {
	private active = 0;
	private readonly isControl: (id: string) => boolean;
	private readonly roots: (path: string) => readonly string[];
	private readonly audit: (entry: ControlFileAudit) => Promise<void>;
	constructor(
		isControl: (id: string) => boolean,
		roots: (path: string) => readonly string[],
		audit: (entry: ControlFileAudit) => Promise<void>,
	) {
		this.isControl = isControl;
		this.roots = roots;
		this.audit = audit;
	}

	async read(caller: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.isControl(caller)) throw new Error("Only the control chat can read local files");
		if (args.host !== undefined && args.host !== "local") throw new Error("Remote-host files are unsupported");
		if (
			typeof args.path !== "string" ||
			!isAbsolute(args.path) ||
			args.path.length > 4096 ||
			args.path.includes("\0") ||
			args.path.startsWith("//")
		)
			throw new Error("Expected one absolute local file path; remote paths and URLs are unsupported");
		if (this.active >= 2) throw new Error("Control file reads are busy; retry shortly");
		this.active++;
		const path = resolve(args.path);
		let bytes: number | undefined;
		try {
			const candidates = this.roots(path).filter((root) => isAbsolute(root) && inside(path, resolve(root)));
			if (!candidates.length) throw new Error("File is outside the allowed roots");
			const target = await realpath(path);
			let approved: { declared: string; canonical: string } | undefined;
			for (const declared of candidates) {
				if ((await lstat(declared).catch(() => undefined))?.isSymbolicLink()) continue;
				const canonical = await realpath(declared).catch(() => undefined);
				if (canonical && inside(target, canonical)) {
					approved = { declared, canonical };
					break;
				}
			}
			if (!approved) throw new Error("File symlink escapes the allowed root");
			const root = approved;
			const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const initial = await handle.stat();
				if (!initial.isFile()) throw new Error("Unsupported file type: expected a regular file");
				bytes = initial.size;
				const verify = async () => {
					const [current, named, canonical, canonicalRoot] = await Promise.all([
						handle.stat(),
						stat(target),
						realpath(path),
						realpath(root.declared),
					]);
					if (
						!this.isControl(caller) ||
						!this.roots(path).some((allowed) => resolve(allowed) === resolve(root.declared)) ||
						canonical !== target ||
						canonicalRoot !== root.canonical ||
						(await realpath(target)) !== target ||
						current.dev !== named.dev ||
						current.ino !== named.ino ||
						current.size !== initial.size ||
						current.mtimeMs !== initial.mtimeMs
					)
						throw new Error("File or allowed root changed during read; retry explicitly");
				};
				await verify();
				const extension = extname(path).toLowerCase(),
					mimeType = images[extension];
				if (!mimeType && !texts.has(extension) && !textNames.has(basename(path)))
					throw new Error(`Unsupported file type ${extension || "(no extension)"} (${bytes} bytes)`);
				if (mimeType && bytes > CONTROL_IMAGE_BYTES)
					throw new Error(`Image is ${bytes} bytes; limit is ${CONTROL_IMAGE_BYTES} bytes`);
				const cap = mimeType ? CONTROL_IMAGE_BYTES : CONTROL_TEXT_BYTES;
				const data = Buffer.alloc(Math.min(bytes, cap));
				let offset = 0;
				while (offset < data.length) {
					const read = await handle.read(data, offset, data.length - offset, offset);
					if (!read.bytesRead) break;
					offset += read.bytesRead;
				}
				if (offset !== data.length) throw new Error("File changed during read");
				await verify();
				let result: Record<string, unknown>,
					returnedBytes = data.length;
				if (mimeType) {
					if (!imageSignature(data, mimeType))
						throw new Error(`Unsupported or invalid ${mimeType} image (${bytes} bytes)`);
					result = { untrusted: true, path, bytes, mimeType, data: data.toString("base64") };
				} else {
					if (data.includes(0)) throw new Error(`Unsupported binary file (${bytes} bytes)`);
					// Do not split a UTF-8 character at the text cap. Reject invalid encodings otherwise.
					let text: string | undefined;
					for (let trim = 0; trim <= (bytes > cap ? 3 : 0); trim++) {
						try {
							text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, data.length - trim));
							returnedBytes -= trim;
							break;
						} catch {}
					}
					if (text === undefined) throw new Error(`Unsupported non-UTF-8 text (${bytes} bytes)`);
					result = {
						untrusted: true,
						path,
						bytes,
						returnedBytes,
						truncated: returnedBytes < bytes,
						quotedContent: text,
					};
				}
				await this.audit({ caller, path, bytes, returnedBytes, outcome: "read" });
				await verify();
				return result;
			} finally {
				await handle.close();
			}
		} catch (error) {
			await this.audit({ caller, path, ...(bytes === undefined ? {} : { bytes }), outcome: "denied" });
			throw error;
		} finally {
			this.active--;
		}
	}
}
