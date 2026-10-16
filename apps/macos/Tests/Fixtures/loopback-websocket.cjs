// TEST ONLY. Bounded RFC6455 text/binary/control subset, Node stdlib, not production transport.
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createServer } = require("node:http");
const MAX_FRAME = 128 * 1024, MAX_QUEUE = 256 * 1024;
function frame(opcode, payload) {
	const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10);
	header[0] = 0x80 | opcode;
	if (header.length === 2) header[1] = payload.length;
	else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
	else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
	return Buffer.concat([header, payload]);
}
class Peer extends EventEmitter {
	OPEN = 1; CLOSING = 2; CLOSED = 3; readyState = 1;
	pending = Buffer.alloc(0); fragments = []; fragmentBytes = 0; fragmentOpcode = 0; frames = 0; closeCode = 1006;
	constructor(socket) {
		super(); this.socket = socket;
		socket.on("data", (chunk) => this.receive(chunk));
		socket.on("error", () => this.terminate());
		socket.on("close", () => {
			clearTimeout(this.deadline); this.readyState = this.CLOSED;
			this.pending = Buffer.alloc(0); this.fragments = [];
			this.emit("close", this.closeCode, Buffer.alloc(0));
		});
	}
	get bufferedAmount() { return this.socket.writableLength; }
	write(opcode, payload, callback) {
		if (this.readyState !== this.OPEN || this.socket.destroyed) { callback?.(new Error("Fixture socket closed")); return; }
		if (payload.length > MAX_FRAME || this.bufferedAmount + payload.length + 10 > MAX_QUEUE) { this.terminate(); return; }
		this.socket.write(frame(opcode, payload), callback);
	}
	send(value, callback) {
		const bytes = ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
		this.write(typeof value === "string" ? 1 : 2, bytes, callback);
	}
	ping(value = "", callback) { const bytes = Buffer.from(value); if (bytes.length > 125) this.terminate(); else this.write(9, bytes, callback); }
	close(code = 1000, reason = "") {
		if (this.readyState !== this.OPEN) return;
		const bytes = Buffer.from(reason);
		if (!Number.isInteger(code) || !((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999)) || bytes.length > 123) { this.terminate(); return; }
		const payload = Buffer.alloc(2 + bytes.length); payload.writeUInt16BE(code); bytes.copy(payload, 2);
		this.finishClose(payload, code);
	}
	finishClose(payload, code) {
		this.write(8, payload); this.closeCode = code; this.readyState = this.CLOSING;
		this.pending = Buffer.alloc(0); this.fragments = [];
		this.socket.end(); this.deadline = setTimeout(() => this.terminate(), 1000); this.deadline.unref();
	}
	terminate() { this.socket.destroy(); }
	receive(chunk) {
		if (this.readyState !== this.OPEN) return;
		if (this.pending.length + chunk.length > MAX_QUEUE) { this.close(1009, "Fixture frame capacity"); return; }
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		while (this.readyState === this.OPEN && this.pending.length >= 2) {
			const fin = !!(this.pending[0] & 0x80), opcode = this.pending[0] & 15;
			if ((this.pending[0] & 0x70) || !(this.pending[1] & 0x80)) { this.close(1002, "Masked frames required"); return; }
			let length = this.pending[1] & 127, offset = 2;
			if (length === 126) {
				if (this.pending.length < 4) return;
				length = this.pending.readUInt16BE(2); offset = 4;
			} else if (length === 127) {
				if (this.pending.length < 10) return;
				const wide = this.pending.readBigUInt64BE(2);
				if (wide > BigInt(MAX_FRAME)) { this.close(1009, "Fixture frame capacity"); return; }
				length = Number(wide); offset = 10;
			}
			if (length > MAX_FRAME || (opcode >= 8 && (!fin || length > 125))) { this.close(1002, "Invalid fixture frame"); return; }
			if (this.pending.length < offset + 4 + length) return;
			if (++this.frames > 128) { this.close(1008, "Fixture message capacity"); return; }
			const mask = this.pending.subarray(offset, offset + 4), payload = Buffer.allocUnsafe(length);
			for (let i = 0; i < length; i++) payload[i] = this.pending[offset + 4 + i] ^ mask[i % 4];
			this.pending = this.pending.subarray(offset + 4 + length);
			if (opcode === 8) {
				if (length === 1) { this.close(1002, "Invalid fixture close"); return; }
				const code = length ? payload.readUInt16BE(0) : 1005;
				if (length && !((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))) { this.close(1002, "Invalid fixture close"); return; }
				try { new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2)); }
				catch { this.close(1007, "Invalid fixture close reason"); return; }
				this.finishClose(payload, code); return;
			}
			if (opcode === 9) { this.write(10, payload); this.emit("ping", payload); continue; }
			if (opcode === 10) { this.emit("pong", payload); continue; }
			if (opcode !== 0 && opcode !== 1 && opcode !== 2) { this.close(1003, "Unsupported fixture opcode"); return; }
			if ((opcode === 0 && !this.fragmentOpcode) || (opcode !== 0 && this.fragmentOpcode)) { this.close(1002, "Invalid fixture fragments"); return; }
			if (opcode !== 0) this.fragmentOpcode = opcode;
			this.fragmentBytes += length;
			if (this.fragmentBytes > MAX_FRAME) { this.close(1009, "Fixture message capacity"); return; }
			this.fragments.push(payload);
			if (fin) {
				const body = Buffer.concat(this.fragments, this.fragmentBytes), binary = this.fragmentOpcode === 2;
				this.fragments = []; this.fragmentBytes = 0; this.fragmentOpcode = 0;
				if (!binary) {
					try { new TextDecoder("utf-8", { fatal: true }).decode(body); }
					catch { this.close(1007, "Invalid fixture text"); return; }
				}
				this.emit("message", body, binary);
			}
		}
		if (!this.pending.length) this.pending = Buffer.alloc(0);
	}
}
class WebSocketServer extends EventEmitter {
	clients = new Set(); connections = 0;
	constructor({ server, host = "127.0.0.1", port = 0 } = {}) {
		super();
		if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Fixture must bind loopback");
		this.ownsServer = !server;
		this.server = server ?? createServer({ maxHeaderSize: 4096 }, (_req, res) => { res.writeHead(404); res.end(); });
		this.upgrade = (req, socket, head) => {
			const key = req.headers["sec-websocket-key"], address = this.server.address();
			if (!address || !["127.0.0.1", "::1"].includes(address.address) || this.connections >= 16 || this.clients.size >= 8 ||
				req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket" ||
				!req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade") || req.headers["sec-websocket-version"] !== "13" ||
				typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) { socket.destroy(); return; }
			const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
			socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
			const peer = new Peer(socket); this.connections++; this.clients.add(peer);
			peer.once("close", () => this.clients.delete(peer));
			this.emit("connection", peer, req);
			if (head.length) peer.receive(head);
		};
		this.server.on("upgrade", this.upgrade);
		this.listening = () => this.emit("listening");
		this.error = (error) => { if (this.listenerCount("error")) this.emit("error", error); };
		this.server.on("listening", this.listening); this.server.on("error", this.error);
		if (this.ownsServer) { this.server.maxHeadersCount = 16; this.server.headersTimeout = 5000; this.server.requestTimeout = 5000; this.server.listen(port, host); }
	}
	address() { return this.server.address(); }
	close(callback) {
		for (const peer of this.clients) peer.terminate();
		this.server.off("upgrade", this.upgrade); this.server.off("listening", this.listening); this.server.off("error", this.error);
		const done = () => { this.emit("close"); callback?.(); };
		if (this.ownsServer) this.server.close(done); else queueMicrotask(done);
	}
}
/** Fixture ownership, not a protocol timeout. Parent must keep an explicit stdin pipe open.
 * EOF/SIGTERM closes resources and exits; a three-minute orphan guard exceeds the native case budget.
 */
function ownFixtureLifetime(close, maximumMilliseconds = 180_000) {
	if (!Number.isInteger(maximumMilliseconds) || maximumMilliseconds < 1 || maximumMilliseconds > 180_000)
		throw new Error("Invalid fixture lifetime");
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true; clearTimeout(watchdog);
		const force = setTimeout(() => process.exit(0), 1000); force.unref();
		Promise.resolve().then(close).then(() => process.exit(0), () => process.exit(1));
	};
	const watchdog = setTimeout(stop, maximumMilliseconds); watchdog.unref();
	process.stdin.resume(); process.stdin.once("end", stop); process.once("SIGTERM", stop);
	return stop;
}
module.exports = { WebSocketServer, ownFixtureLifetime };
