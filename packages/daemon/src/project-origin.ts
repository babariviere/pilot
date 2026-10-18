import { githubRepository } from "./github.ts";

/** Pure navigation identity. Never resolves SSH aliases, expands credentials or contacts a server. */
export function projectOriginIdentity(raw: string): string | null {
	if (raw.length > 4096 || /[\s\x00-\x1f]/.test(raw) || /\/\.{1,2}(?:\/|$)/.test(raw)) return null;
	let host: string,
		path: string,
		port = "";
	const scp = /^(?:[^@/:]+@)?([a-zA-Z0-9.-]+):([^\s]+)$/.exec(raw);
	if (scp && !raw.includes("://")) {
		host = scp[1]!;
		path = scp[2]!;
	} else {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return null;
		}
		if (!["ssh:", "https:", "http:"].includes(url.protocol) || url.search || url.hash) return null;
		host = url.hostname;
		path = url.pathname.slice(1);
		if (url.port && !(url.protocol === "ssh:" && url.port === "22")) port = `:${url.port}`;
	}
	host = host.toLowerCase();
	// Short SSH names are unresolved aliases, not repository-server identity.
	if (!host.includes(".") || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host)) return null;
	path = path.replace(/\/$/, "").replace(/\.git$/, "");
	const parts = path.split("/");
	if (parts.length < 2 || parts.some((p) => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === "." || p === "..")) return null;
	if (host === "github.com" && !port) {
		try {
			const repo = githubRepository(`https://${host}/${path}`);
			path = `${repo.owner}/${repo.name}`.toLowerCase();
		} catch {
			return null;
		}
	}
	return JSON.stringify([host + port, path]);
}
