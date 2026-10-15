// Administrative CLI only. Never expose invitation generation through a public endpoint.
//   node scripts/invite.mjs [days]   (uses DATABASE_URL if set, otherwise ACCOUNT_DB / data/accounts.sqlite)
import { Accounts } from '../src/accounts.js';
import { config } from '../src/config.js';
const db = await Accounts.open({ root: config.root });
try { console.log(await db.invite(Number(process.argv[2] || 7))); } finally { await db.close(); }
