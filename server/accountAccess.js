import { Accounts } from '../music-service/src/accounts.js';
import { config } from '../music-service/src/config.js';
// Same database as music-service: DATABASE_URL (PostgreSQL) or ACCOUNT_DB / music-service/data/accounts.sqlite.
let database;
export async function authorizeAccount(token) {
  if (process.env.AUTH_MODE === 'legacy') return;
  database ??= Accounts.open({ root: config.root }).catch((e) => { database = null; throw e; });
  return (await database).user(token, true);
}
export async function authorizeRequest(req, res) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || new URL(req.url, 'http://localhost').searchParams.get('token');
    await authorizeAccount(token);
    return true;
  } catch (e) {
    res.writeHead(e.status || 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message, code: e.code }));
    return false;
  }
}
