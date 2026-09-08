/**
 * WebSocket compatibility layer.
 *
 * Bun and Node.js 22+ expose WebSocket as a global. Older Node.js versions
 * (18-21) do not, so when the bundle is built with `--target node` the global
 * may be missing. In that case we fall back to the `ws` npm package which is
 * listed as a dependency for exactly this purpose.
 */

let WS: typeof WebSocket;

if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsModule = require('ws');
  WS = (wsModule.default ?? wsModule) as typeof WebSocket;
}

export { WS as WebSocket };

/**
 * Count protocol-level ping frames as socket activity.
 *
 * An idle Socket Mode connection carries no text frames — its keepalive is
 * entirely ping/pong at the protocol level, which `onmessage` never sees. A
 * heartbeat fed only by `onmessage` therefore executes every healthy idle
 * connection on schedule (#498).
 *
 * Ping visibility differs per runtime, so both mechanisms are attached and
 * whichever exists wins:
 *
 * | Runtime          | Mechanism                    |
 * |------------------|------------------------------|
 * | Bun (native)     | `addEventListener('ping')`   |
 * | Node 20 (`ws`)   | `.on('ping')` (EventEmitter) |
 * | Node 22+ (undici)| none — see below             |
 *
 * undici's WHATWG WebSocket auto-pongs internally and exposes no frame-level
 * ping visibility at all, so that runtime stays uncovered at this layer;
 * there the heartbeat's own probe (`BasePlatformClient.sendHeartbeatProbe`,
 * a client-initiated `ping` whose reply counts as activity) keeps a quiet
 * socket alive.
 * Both attachments are optional-chained, so a runtime lacking either is a
 * silent no-op rather than a throw.
 */
export function countPingsAsActivity(ws: unknown, onPing: () => void): void {
  (ws as EventTarget).addEventListener?.('ping', onPing);
  (ws as { on?: (event: string, listener: () => void) => void }).on?.('ping', onPing);
}
