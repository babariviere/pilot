/** Disconnect rather than lose state deltas. Reconnection/subscription provides a fresh snapshot. */
export interface BackpressureSocket {
	readonly OPEN: number;
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: string, callback: (error?: Error) => void): void;
	close(code: number, reason: string): void;
	terminate(): void;
	once(event: "close", listener: () => void): unknown;
}

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
// A full-size snapshot needs headroom for live deltas while it drains. A one-frame queue cap
// would repeatedly disconnect even a healthy reader of a near-limit active transcript.
export function boundedSender(socket: BackpressureSocket, maxBytes = 2 * MAX_FRAME_BYTES, graceMs = 1000) {
	let pendingBytes = 0;
	let disconnected = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	socket.once("close", () => {
		disconnected = true;
		clearTimeout(timer);
	});
	const disconnect = () => {
		if (disconnected) return;
		disconnected = true;
		// A peer that never reads the close frame must not retain subscriptions indefinitely.
		timer = setTimeout(() => socket.terminate(), graceMs);
		timer.unref();
		socket.close(1013, "Slow consumer. Reconnect for a fresh snapshot.");
	};
	return (data: string): void => {
		if (disconnected || socket.readyState !== socket.OPEN) return;
		const bytes = Buffer.byteLength(data);
		if (bytes > MAX_FRAME_BYTES || Math.max(pendingBytes, socket.bufferedAmount) + bytes > maxBytes) {
			disconnect();
			return;
		}
		pendingBytes += bytes;
		try {
			socket.send(data, (error) => {
				pendingBytes -= bytes;
				if (error) disconnect();
			});
		} catch {
			pendingBytes -= bytes;
			disconnect();
		}
	};
}
