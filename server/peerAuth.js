import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

export async function authorizePeerRequest(req, { accounts, env = process.env } = {}) {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  if (env.AUTH_MODE !== 'legacy') {
    if (!accounts || !token) throw new Error('Account authentication required');
    return accounts.user(token, true);
  }
  const expected = env.API_TOKEN || '';
  if (expected && (Buffer.byteLength(token) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))) {
    throw new Error('Invalid API token');
  }
  return null;
}

// PeerServer's default upgrade listener also rejects /ws. Route upgrades explicitly
// and finish asynchronous account authentication before handing a socket to PeerJS.
export function createAuthenticatedPeerWebSocket({ server, path }, auth) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const upgrade = async (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== path) return;
    const onError = () => {};
    socket.on('error', onError);
    try {
      await authorizePeerRequest(req, auth);
      if (!socket.destroyed) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } catch {
      if (!socket.destroyed) socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } finally { socket.removeListener('error', onError); }
  };
  server.on('upgrade', upgrade);
  server.once('close', () => { server.off('upgrade', upgrade); wss.close(); });
  return wss;
}
