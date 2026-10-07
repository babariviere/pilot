/**
 * Browsers let any web page talk to loopback servers, and agents run shell commands. Pilot's
 * clients (the macOS app, curl, CLIs) send no Origin header, while browsers always send one on
 * WebSocket upgrades and cross-site writes. Reject every request that carries an Origin.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
	return origin === undefined;
}
