// Administrative CLI only. Never expose password resets through a public endpoint.
//   node scripts/reset-password.mjs <username> <new password>   (uses DATABASE_URL if set, otherwise ACCOUNT_DB / data/accounts.sqlite)
// Rehashes the password and signs the account out on every device.
import { Accounts } from '../src/accounts.js';
import { config } from '../src/config.js';
const [username, password] = process.argv.slice(2);
if (!username || !password) { console.error('用法: node scripts/reset-password.mjs <账号名> <新密码（12–128 位）>'); process.exit(2); }
const db = await Accounts.open({ root: config.root });
try {
  const user = await db.resetPassword(username, password);
  console.log(`已重置 ${user.username} 的密码（ID ${user.shortId}），所有设备需要重新登录。`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await db.close(); }
