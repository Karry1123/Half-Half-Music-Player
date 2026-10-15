import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export let IS_TURN_ENABLED = true;
let guard;
export function cloudflareTurnEnabled() { return guard ? guard.enabled() : IS_TURN_ENABLED; }
export function setTurnQuotaGuard(value) { guard = value; IS_TURN_ENABLED = value?.enabled() ?? true; }
const monthOf = now => new Date(now).toISOString().slice(0, 7);
const positive = (value, fallback) => Number(value) > 0 ? Number(value) : fallback;

export function fileQuotaStore(filename) {
  return {
    async load() { try { return JSON.parse(await readFile(filename, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async save(state) {
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(`${filename}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
    },
  };
}

export async function databaseQuotaStore(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS turn_quota_state(id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  return {
    async load() { const rows = await db.all("SELECT state FROM turn_quota_state WHERE id='monthly'"); return rows[0] ? JSON.parse(rows[0].state) : null; },
    async save(state) { await db.run("INSERT INTO turn_quota_state(id,state) VALUES('monthly',$1) ON CONFLICT(id) DO UPDATE SET state=excluded.state", [JSON.stringify(state)]); },
  };
}

// https://developers.cloudflare.com/realtime/turn/analytics/
// No dimensions: one aggregate across every TURN key, not a truncated top-N list.
export async function fetchMonthlyTurnBytes(env, fetcher = fetch, now = Date.now()) {
  const dateTo = new Date(now).toISOString().slice(0, 10);
  const query = `query($accountId: string, $dateFrom: Date, $dateTo: Date) {
    viewer { accounts(filter: {accountTag: $accountId}) {
      callsTurnUsageAdaptiveGroups(limit: 1, filter: {date_geq: $dateFrom, date_leq: $dateTo}) {
        sum { egressBytes }
      }
    } }
  }`;
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { accountId: env.CLOUDFLARE_ACCOUNT_ID, dateFrom: `${monthOf(now)}-01`, dateTo } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Cloudflare analytics HTTP ${response.status}`);
  const data = await response.json();
  if (data.errors?.length) throw new Error('Cloudflare analytics query failed');
  const accounts = data.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('Cloudflare analytics account missing');
  let total = 0;
  for (const account of accounts) {
    if (!Array.isArray(account.callsTurnUsageAdaptiveGroups)) throw new Error('Invalid TURN analytics response');
    for (const group of account.callsTurnUsageAdaptiveGroups) {
      const bytes = group.sum?.egressBytes;
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid TURN byte count');
      total += bytes;
    }
  }
  return total;
}

export class TurnQuotaGuard {
  constructor({ env = process.env, store, fetcher = fetch, mailer, now = Date.now, logger = console } = {}) {
    Object.assign(this, { env, store, fetcher, mailer, now, logger });
    this.configured = !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ANALYTICS_TOKEN);
    this.state = { month: monthOf(now()), disabled: false, alerts: {} };
  }
  enabled() {
    const enabled = this.env.IS_TURN_ENABLED !== 'false' && !(this.state.month === monthOf(this.now()) && this.state.disabled);
    IS_TURN_ENABLED = enabled;
    return enabled;
  }
  async init() {
    if (!this.configured) { this.logger.info('[turn-quota] Analytics credentials unset; quota monitoring disabled'); return this; }
    try { const saved = await this.store.load(); if (saved?.month === this.state.month) this.state = saved; }
    catch (e) { this.state.disabled = true; this.logger.error('[turn-quota] Cannot load persisted state; credentials paused:', e.message); }
    this.enabled();
    return this;
  }
  async alert(kind, percent) {
    if (this.state.alerts[kind]) return;
    const text = `Half&Half TURN ${this.state.month}: ${percent.toFixed(1)}% of quota used. ${kind === 'kill' ? 'Cloudflare credential issuance disabled for this month.' : 'Usage warning.'}`;
    if (this.mailer) await this.mailer.sendMail({ from: this.env.SMTP_FROM, to: this.env.ALERT_EMAIL_TO, subject: `Half&Half TURN ${kind}`, text });
    else this.logger.warn(`[turn-quota] SMTP unset; ${text}`);
    this.state.alerts[kind] = true;
    await this.store.save(this.state);
  }
  async check() {
    if (!this.configured || this.running) return;
    this.running = true;
    try {
      const month = monthOf(this.now());
      if (this.state.month !== month) this.state = { month, disabled: false, alerts: {} };
      const bytes = await fetchMonthlyTurnBytes(this.env, this.fetcher, this.now());
      this.state.bytes = bytes;
      const percent = bytes / (positive(this.env.TURN_QUOTA_GB, 1000) * 1e9) * 100;
      const kill = Math.min(100, positive(this.env.TURN_QUOTA_KILL_PERCENT, 90));
      const warn = Math.min(kill, positive(this.env.TURN_QUOTA_WARN_PERCENT, 50));
      if (percent >= kill) this.state.disabled = true;
      this.enabled(); // Stop issuance before persistence or mail, even if either fails.
      await this.store.save(this.state);
      if (percent >= warn) await this.alert('warn', percent);
      if (percent >= kill) await this.alert('kill', percent);
    } catch (e) { this.logger.error('[turn-quota] Check failed:', e.message); }
    finally { this.running = false; }
  }
  start() { if (this.configured && !this.timer) { void this.check(); this.timer = setInterval(() => void this.check(), 3600000); this.timer.unref(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
}
