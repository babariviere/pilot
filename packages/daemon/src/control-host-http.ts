import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ControlHomeEnrollmentRequest,
	ControlHostApprovalDecision,
	ControlHostApprovalInput,
	ControlUnpairRequest,
} from "@pilot/protocol";
import { ControlHostError } from "./control-host-policy.ts";
import type { ControlHosts } from "./control-hosts.ts";

export async function controlBody(req: IncomingMessage, maxBytes = 70 * 1024): Promise<string> {
	if (!req.headers["content-type"]?.startsWith("application/json"))
		throw new ControlHostError("invalid_request", "Expected application/json", 400);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const b = Buffer.from(chunk);
		size += b.length;
		if (size > maxBytes) throw new ControlHostError("invalid_request", "Control request too large", 400);
		chunks.push(b);
	}
	return Buffer.concat(chunks).toString("utf8");
}
export function controlHeaders(req: IncomingMessage) {
	const get = (name: string) => {
		const value = req.headers[name];
		return typeof value === "string" ? value : undefined;
	};
	return { proof: get("x-pilot-control-proof"), signature: get("x-pilot-control-signature") };
}
export function controlJSON<T>(bytes: string): T {
	try {
		return JSON.parse(bytes) as T;
	} catch {
		throw new ControlHostError("invalid_request", "Invalid Control JSON", 400);
	}
}
export async function controlHostRoute(
	hosts: ControlHosts,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const p = url.pathname.split("/").filter(Boolean);
	if (p[0] !== "api" || p[1] !== "control-hosts") return false;
	const send = (status: number, result: unknown) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(result));
		return true;
	};
	try {
		const id = p[2];
		if (!id) throw new ControlHostError("not_found", "Unknown Control route", 404);
		const body = req.method === "GET" ? "" : await controlBody(req);
		const inspect = req.method === "GET" && p.length === 3;
		const pairing = p[3] === "pairing" && p[4] === "ack" && p.length === 5 && req.method === "POST";
		const appKeyId = await hosts.authenticate(
			controlHeaders(req),
			req.method!,
			req.url!,
			body,
			inspect || pairing ? { bindingId: id, kind: "inspect" } : undefined,
		);
		if (inspect) return send(200, await hosts.state(id));
		if (pairing) return send(200, await hosts.pairingAck(id, controlJSON(body)));
		if (p[3] === "courier-capability" && p[4] === "refresh" && p.length === 5 && req.method === "POST")
			return send(200, await hosts.refresh(id, controlJSON(body), appKeyId));
		if (p[3] === "enrollment" && p[4] === "preview" && p.length === 5 && req.method === "POST")
			return send(200, await hosts.preview(id, controlJSON(body)));
		if (p[3] === "enrollment" && p.length === 4 && req.method === "PUT")
			return send(200, await hosts.enroll(id, controlJSON<ControlHomeEnrollmentRequest>(body), appKeyId));
		if (p[3] === "approval-requests") {
			if (p.length === 4 && req.method === "POST")
				return send(200, await hosts.issue(id, controlJSON<ControlHostApprovalInput>(body), appKeyId));
			if (p.length === 5 && req.method === "GET") return send(200, await hosts.approval(id, p[4]!));
			if (p.length === 6 && p[5] === "decision" && req.method === "POST")
				return send(200, await hosts.decision(id, p[4]!, controlJSON<ControlHostApprovalDecision>(body), appKeyId));
		}
		if (p[3] === "unpair" && p.length === 4 && req.method === "POST")
			return send(200, await hosts.unpair(id, controlJSON<ControlUnpairRequest>(body), appKeyId));
		throw new ControlHostError("not_found", "Unsupported Control host route", 404);
	} catch (error) {
		if (error instanceof ControlHostError) return send(error.status, error.response());
		throw error;
	}
}
