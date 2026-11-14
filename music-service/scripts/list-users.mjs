// Administrative CLI only: lists every account (never passwords, which are stored as salted scrypt hashes).
//   node scripts/list-users.mjs   (uses DATABASE_URL if set, otherwise ACCOUNT_DB / data/accounts.sqlite)
import { Accounts } from '../src/accounts.js';
import { config } from '../src/config.js';
const db = await Accounts.open({ root: config.root });
try {
  const users = await db.listUsers();
  if (!users.length) { console.log('还没有任何账号'); } else {
    console.table(users.map(u => ({ 账号名: u.username, ID: u.shortId, 昵称: u.nickname || '', 已激活: Number(u.activated) ? '是' : '否', 登录设备: Number(u.sessions), 注册时间: new Date(Number(u.createdAt)).toISOString().slice(0, 10) })));
  }
} finally { await db.close(); }
