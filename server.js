// 全网羊毛工具 · 后端（零外部依赖，Node 20+ 原生 http + node:sqlite）
// 启动：node server.js，端口环境变量 PORT（默认 3000），监听 0.0.0.0。
// 数据：DATABASE_PATH 环境变量，默认 ./data/app.db。
// 注意：本文件不含任何真实凭据、手机号、邮箱；凭据只存在 data/app.db（已 gitignore）。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/app.db');
const CTP_URL = process.env.CTP_URL || 'http://127.0.0.1:3210';
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// ---------- 建表（不存在则创建；deals 已存在时只补缺失的 worth_cny 列） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  benefit TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  link TEXT,
  notes TEXT,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  pinned INTEGER NOT NULL DEFAULT 0,
  visited INTEGER NOT NULL DEFAULT 0,
  visited_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  play_types TEXT NOT NULL DEFAULT '[]',
  est_earn_low REAL,
  est_earn_high REAL,
  fdv_usd REAL,
  pool_ratio REAL,
  active_addresses INTEGER,
  worth_cny REAL,
  forwarded_ctp INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS discovery_runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  added INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  note TEXT
);
CREATE TABLE IF NOT EXISTS push_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  credential TEXT
);
CREATE TABLE IF NOT EXISTS push_prefs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  push_interval_hours INTEGER NOT NULL DEFAULT 6,
  new_deals INTEGER NOT NULL DEFAULT 0,
  only_airdrop INTEGER NOT NULL DEFAULT 0,
  only_001 INTEGER NOT NULL DEFAULT 0,
  expiring_24h INTEGER NOT NULL DEFAULT 0,
  favorite_categories INTEGER NOT NULL DEFAULT 0,
  daily_digest INTEGER NOT NULL DEFAULT 0,
  last_flush_at INTEGER
);
CREATE TABLE IF NOT EXISTS push_logs (
  id INTEGER PRIMARY KEY,
  channel_id TEXT,
  kind TEXT,
  status TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proxy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'http',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 7890,
  username TEXT NOT NULL DEFAULT '',
  password TEXT
);
CREATE TABLE IF NOT EXISTS admin_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  updated_at INTEGER
);
`);
// 旧库迁移：deals 表若缺 worth_cny 列则补上（不改动已有数据）。
if (!db.prepare(`PRAGMA table_info(deals)`).all().some((c) => c.name === 'worth_cny')) {
  db.exec(`ALTER TABLE deals ADD COLUMN worth_cny REAL`);
}
// 旧库迁移：forwarded_ctp（空投转发到看板的标记：0=未转发 1=已转发 2=看板已有同名卡片）
if (!db.prepare(`PRAGMA table_info(deals)`).all().some((c) => c.name === 'forwarded_ctp')) {
  db.exec(`ALTER TABLE deals ADD COLUMN forwarded_ctp INTEGER NOT NULL DEFAULT 0`);
}
// 元数据 kv（空投上次推送时间等）
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

// ---------- 渠道默认值 ----------
const CHANNEL_DEFS = [
  ['wecom', '企业微信'],
  ['dingtalk', '钉钉'],
  ['feishu', '飞书'],
  ['telegram', 'Telegram Bot'],
  ['serverchan', 'Server酱 Turbo'],
  ['pushplus', 'PushPlus'],
  ['bark', 'Bark'],
  ['discord', 'Discord'],
];
for (const [id, name] of CHANNEL_DEFS) {
  db.prepare(`INSERT OR IGNORE INTO push_channels (id, name, enabled, credential) VALUES (?, ?, 0, NULL)`).run(id, name);
}
db.prepare(`INSERT OR IGNORE INTO push_prefs (id) VALUES (1)`).run();

// ---------- 小工具 ----------
const now = () => Date.now();
function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function safeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
function toJsonArray(v) { return JSON.stringify(Array.isArray(v) ? v : []); }
function dealOut(row) {
  if (!row) return null;
  return { ...row, pinned: row.pinned ? 1 : 0, visited: row.visited ? 1 : 0,
    tags: safeJsonArray(row.tags), play_types: safeJsonArray(row.play_types) };
}
function getDeal(id) {
  const row = db.prepare(`SELECT * FROM deals WHERE id = ?`).get(Number(id));
  return row ? dealOut(row) : null;
}
function maskCredential(cred) {
  if (!cred) return '';
  return cred.length > 4 ? '••••' + cred.slice(-4) : '••••';
}
// FDV 模型：单号预估 = FDV × 空投总池比例 ÷ 净活跃地址 × 权重（基础 1.0x / 高 2.5x）。
// 三参数缺任一则返回 null（不编数字）。
function calcEst(fdv, pool, active) {
  const f = Number(fdv), p = Number(pool), a = Number(active);
  if (!Number.isFinite(f) || !Number.isFinite(p) || !Number.isFinite(a) || a <= 0) return null;
  return { low: f * p / a * 1.0, high: f * p / a * 2.5 };
}
// 按标题/内容关键词推断玩法标签（9 类）。
function inferPlayTypes(text) {
  const t = String(text || '');
  const out = [];
  if (t.includes('挂机') || t.includes('节点')) out.push('node');
  if (t.includes('水龙头')) out.push('faucet');
  if (t.includes('插件')) out.push('extension');
  if (t.includes('铸造')) out.push('mint');
  if (t.includes('推荐') || t.includes('拉人')) out.push('referral');
  if (t.includes('测试网')) out.push('testnet');
  if (t.includes('积分')) out.push('points');
  if (t.includes('钱包连接') || t.includes('连接钱包')) out.push('wallet');
  if (out.length === 0) out.push('claim');
  return out;
}
function insertDeal(d) {
  const t = now();
  const est = calcEst(d.fdv_usd, d.pool_ratio, d.active_addresses);
  const tags = d.tags?.length ? d.tags : inferPlayTypes(`${d.title || ''} ${d.benefit || ''} ${d.conditions || ''}`);
  const play = d.play_types?.length ? d.play_types : inferPlayTypes(`${d.title || ''} ${d.benefit || ''} ${d.conditions || ''}`);
  const r = db.prepare(`INSERT INTO deals
    (title, platform, category, benefit, conditions, link, notes, expiry_date, status,
     pinned, visited, visited_at, created_at, updated_at, published_at,
     tags, play_types, est_earn_low, est_earn_high, fdv_usd, pool_ratio, active_addresses, worth_cny)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.title, d.platform || '', d.category || 'other', d.benefit || '', d.conditions || '',
      d.link || null, d.notes || null, d.expiry_date || null, d.status || 'todo',
      d.pinned !== undefined ? (d.pinned ? 1 : 0) : 0,
      d.visited !== undefined ? (d.visited ? 1 : 0) : 0,
      d.visited ? (d.visited_at ? Number(d.visited_at) || t : t) : null,
      t, t, d.published_at ?? null, toJsonArray(tags), toJsonArray(play),
      est ? est.low : (d.est_earn_low ?? null), est ? est.high : (d.est_earn_high ?? null),
      d.fdv_usd ?? null, d.pool_ratio ?? null, d.active_addresses ?? null, d.worth_cny ?? null);
  return getDeal(r.lastInsertRowid);
}

// ---------- 推送 ----------
// sendToChannel(channel, title, text) -> {ok, message}；失败返回对方的错误信息，不谎报成功。
async function postJson(url, body, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}
async function sendToChannel(channel, title, text) {
  const cred = channel.credential || '';
  if (!cred) return { ok: false, message: '还没填凭据' };
  let r;
  try {
    switch (channel.id) {
      case 'wecom':
      case 'dingtalk':
        r = await postJson(cred, { msgtype: 'text', text: { content: `${title}\n${text}` } });
        break;
      case 'feishu':
        r = await postJson(cred, { msgtype: 'text', content: { text: `${title}\n${text}` } });
        break;
      case 'discord':
        r = await postJson(cred, { content: `**${title}**\n${text}` });
        break;
      case 'telegram': {
        // 凭据格式：<bot_token>|<chat_id>
        const sep = cred.indexOf('|');
        if (sep < 0) return { ok: false, message: 'Telegram 凭据格式应为 token|chat_id' };
        const token = cred.slice(0, sep), chatId = cred.slice(sep + 1);
        r = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: `${title}\n${text}` });
        break;
      }
      case 'serverchan': {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(cred)}.send`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ title, desp: text }), signal: ctrl.signal });
          r = { ok: res.ok, status: res.status, text: await res.text() };
        } catch (e) { r = { ok: false, status: 0, text: String(e?.message || e) }; }
        finally { clearTimeout(timer); }
        break;
      }
      case 'pushplus':
        r = await postJson('https://www.pushplus.plus/send', { token: cred, title, content: text, template: 'txt' });
        break;
      case 'bark': {
        const url = cred.startsWith('http') ? (cred.endsWith('/') ? cred : cred + '/') : `https://api.day.app/${encodeURIComponent(cred)}/`;
        r = await postJson(url, { title, body: text, device_key: cred.startsWith('http') ? undefined : cred });
        break;
      }
      default:
        return { ok: false, message: `未知渠道 ${channel.id}` };
    }
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
  if (r.ok) return { ok: true, message: '发送成功' };
  let detail = (r.text || '').slice(0, 300);
  try { const j = JSON.parse(r.text); detail = j.description || j.message || j.msg || detail; } catch { /* 非 JSON，直接用原文 */ }
  return { ok: false, message: `发送失败（HTTP ${r.status}）：${detail || '无返回信息'}` };
}
function logPush(channelId, kind, ok, message) {
  db.prepare(`INSERT INTO push_logs (channel_id, kind, status, message, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(channelId, kind, ok ? 'ok' : 'failed', String(message || '').slice(0, 500), now());
}
function enabledChannels() {
  return db.prepare(`SELECT * FROM push_channels WHERE enabled = 1 AND credential IS NOT NULL AND credential != ''`).all();
}
function getPrefs() {
  const row = db.prepare(`SELECT * FROM push_prefs WHERE id = 1`).get();
  return { push_interval_hours: row.push_interval_hours, new_deals: !!row.new_deals,
    only_airdrop: !!row.only_airdrop, only_001: !!row.only_001, expiring_24h: !!row.expiring_24h,
    favorite_categories: !!row.favorite_categories, daily_digest: !!row.daily_digest,
    last_flush_at: row.last_flush_at };
}
async function pushToEnabled(title, text, kind) {
  const chans = enabledChannels();
  let sent = 0, skipped = 0;
  for (const ch of chans) {
    const r = await sendToChannel(ch, title, text);
    logPush(ch.id, kind, r.ok, r.message);
    if (r.ok) sent++; else skipped++;
  }
  return { sent, skipped, channels: chans.length };
}
function filterForPrefs(deals, prefs) {
  let list = deals;
  if (prefs.only_airdrop) list = list.filter((d) => d.category === 'airdrop');
  if (prefs.favorite_categories) {
    const favCats = new Set(db.prepare(`SELECT DISTINCT category FROM deals WHERE pinned = 1`).all().map((r) => r.category));
    list = list.filter((d) => favCats.has(d.category));
  }
  if (prefs.expiring_24h) {
    const tomorrow = todayStr(1);
    list = list.filter((d) => d.expiry_date && d.expiry_date <= tomorrow);
  }
  // only_001：前端开关文案是“只推0.01撸”——只推标题 / 权益 / 条件里出现 0.01 的条目
  // （157 条种子数据里共 6 条：84、85、94、96、103、152；85 是 0.99 元买卡、条件里最低实付 0.01 元，也算在内）。
  if (prefs.only_001) list = list.filter((d) => /0\.01/.test([d.title, d.benefit, d.conditions].filter(Boolean).join(' ')));
  return list;
}
function dealLine(d) {
  return `· ${d.title}${d.benefit ? ' — ' + d.benefit : ''}${d.link ? '\n  ' + d.link : ''}`;
}

// ---------- 动作实现 ----------
const CATEGORY_LABELS = { airdrop: '空投', ai: 'AI', esim: 'eSIM', cloud: '云/VPS', scripts: '脚本/工具',
bank: '银行', shopping: '购物', telecom: '运营商', office: '办公', game: '游戏', other: '其他'};

const getMeta = (k) => db.prepare(`SELECT value FROM meta WHERE key = ?`).get(k)?.value ?? null;
const setMeta = (k, v) => db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v));

function getDealStats() {
const total = db.prepare(`SELECT COUNT(*) c FROM deals`).get().c;
const claimable = db.prepare(`SELECT COUNT(*) c FROM deals WHERE status = 'todo'`).get().c;
const unvisited = db.prepare(`SELECT COUNT(*) c FROM deals WHERE visited = 0`).get().c;
const expiring_soon = db.prepare(
`SELECT COUNT(*) c FROM deals WHERE status = 'todo' AND expiry_date IS NOT NULL AND expiry_date >=? AND expiry_date <=?`)
.get(todayStr(0), todayStr(7)).c;
const byCategory = {};
for (const r of db.prepare(`SELECT category, COUNT(*) c FROM deals WHERE visited = 0 GROUP BY category`).all()) byCategory[r.category] = r.c;
const byPlay = {};
for (const r of db.prepare(`SELECT play_types FROM deals WHERE visited = 0`).all()) {
for (const p of safeJsonArray(r.play_types)) byPlay[p] = (byPlay[p] || 0) + 1;
}
const ctpInfo = (() => {
  let last = null;
  try { last = JSON.parse(getMeta('ctp_last_push') || 'null'); } catch { /* ignore */ }
  const pushed = db.prepare(`SELECT COUNT(*) c FROM deals WHERE forwarded_ctp = 1`).get().c;
  const pending = db.prepare(
    `SELECT COUNT(*) c FROM deals WHERE category = 'airdrop' AND status = 'todo' AND forwarded_ctp = 0
     AND (expiry_date IS NULL OR expiry_date >= ?)`).get(todayStr(0)).c;
  return { lastPushAt: last?.ts || null, pushed, pending };
})();
return { total, claimable, expiring_soon, unvisited, byCategory, byPlay, ctp: ctpInfo};
}

// ---------- 转发空投线报到空投看板（CTP，同容器 127.0.0.1:3210） ----------
// 接口约定：POST /api/database/sync {customFeeds:[...]}，CTP 按 feed.id 去重合并，
// 看板卡片由它自己的巡检/跟进流程自动创建。forwarded_ctp: 0=未转发 1=已转发 2=看板已有同名卡片
async function forwardAirdrops() {
  const rows = db.prepare(
    `SELECT * FROM deals WHERE category = 'airdrop' AND status = 'todo' AND forwarded_ctp = 0
     AND (expiry_date IS NULL OR expiry_date >= ?) ORDER BY id DESC`).all(todayStr(0));
  if (!rows.length) return { ok: true, forwarded: 0, deduped: 0 };
  let existing = [];
  try {
    const r = await fetch(`${CTP_URL}/api/projects/progress`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) existing = await r.json();
  } catch { /* 看板不在线时照常推送，靠 feed.id 去重兜底 */ }
  const names = existing.map((p) => String(p.name || '').toLowerCase());
  const feeds = [];
  let deduped = 0;
  for (const d of rows) {
    const name = ctpProjectName(d);
    if (!name) continue;
    const low = name.toLowerCase();
    if (names.some((n) => n === low || n.includes(low) || low.includes(n))) {
      db.prepare(`UPDATE deals SET forwarded_ctp = 2 WHERE id = ?`).run(d.id);
      deduped++;
      continue;
    }
    feeds.push({
      id: `yangmao-d${d.id}`,
      type: 'airdrop',
      title: d.title,
      actionUrl: d.link || '',
      symbolTag: name,
      airdropMeta: {
        projectName: name,
        stage: 'Live',
        ecosystem: '全网羊毛线报',
        estimatedReward: d.benefit || '',
        tasks: d.conditions ? [d.conditions] : [],
        socials: { taskPortal: d.link || '' },
      },
    });
  }
  if (feeds.length) {
    const r = await fetch(`${CTP_URL}/api/database/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFeeds: feeds }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Object.assign(new Error(`CTP sync HTTP ${r.status}`), { code: 502 });
  }
  db.prepare(
    `UPDATE deals SET forwarded_ctp = 1, updated_at = ?
     WHERE category = 'airdrop' AND status = 'todo' AND forwarded_ctp = 0
     AND (expiry_date IS NULL OR expiry_date >= ?)`).run(now(), todayStr(0));
  setMeta('ctp_last_push', JSON.stringify({ ts: Date.now(), pushed: feeds.length, deduped }));
  return { ok: true, forwarded: feeds.length, deduped };
}

// 从线报标题/平台名提取项目名，如 "InfiniFi 官方 X @infiniFi" → "InfiniFi"
function ctpProjectName(d) {
  let base = String(d.platform || '').split(/\s+(?:官方|Official|Twitter|X\s*@|@)/i)[0].trim();
  if (!base || base.length < 2) base = String(d.title || '').replace(/^空投\s*/, '').split(/\s+/)[0].trim();
  return base.replace(/[（(].*$/, '').trim();
}

const actions = {
listDeals(b = {}) {
const offset = Math.max(0, Number(b.offset) || 0);
const limit = Math.min(200, Math.max(1, Number(b.limit) || 20));
const where = [], params = [];
if (b.category) { where.push(`category =?`); params.push(b.category);}
if (b.favorites) { where.push(`pinned = 1`);}
if (b.hideVisited) { where.push(`visited = 0`);}
if (b.filter === 'claimable') { where.push(`status = 'todo'`);}
if (b.filter === 'unvisited') { where.push(`visited = 0`);}
if (b.filter === 'visited') { where.push(`visited = 1`);}
if (b.filter === 'expiring') {
  where.push(`status = 'todo' AND expiry_date IS NOT NULL AND expiry_date >=? AND expiry_date <=?`);
  params.push(todayStr(0), todayStr(7));
}
if (b.search) {
where.push(`(title LIKE? OR platform LIKE? OR benefit LIKE? OR conditions LIKE?)`);
const q = `%${b.search}%`; params.push(q, q, q, q);
}
const sql = `SELECT * FROM deals ${where.length? 'WHERE ' + where.join(' AND '): ''} ORDER BY ${b.filter === 'expiring' ? 'expiry_date ASC' : 'id DESC'}`;
let rows = db.prepare(sql).all(...params).map(dealOut);
if (b.play) rows = rows.filter((d) => d.play_types.includes(b.play));
const total = rows.length;
const deals = rows.slice(offset, offset + limit);
return { deals, total, has_more: offset + deals.length < total};
},

getDealStats() { return getDealStats();},

getSidebarData() {
const stats = getDealStats();
const categories = db.prepare(`SELECT category, COUNT(*) c FROM deals WHERE visited = 0 GROUP BY category ORDER BY c DESC`)
.all().map((r) => ({ id: r.category, label: CATEGORY_LABELS[r.category] || r.category, count: r.c}));
const expiring = db.prepare(
`SELECT id, title, expiry_date FROM deals WHERE status='todo' AND expiry_date IS NOT NULL AND expiry_date >=? AND expiry_date <=? ORDER BY expiry_date ASC LIMIT 10`)
.all(todayStr(0), todayStr(7));
const latest = db.prepare(`SELECT id, title, created_at FROM deals ORDER BY id DESC LIMIT 5`).all();
const favorites = db.prepare(`SELECT id, title FROM deals WHERE pinned = 1 ORDER BY id DESC LIMIT 20`).all();
const favoritesCount = db.prepare(`SELECT COUNT(*) c FROM deals WHERE pinned = 1`).get().c;
return { stats, categories, expiring, latest, favorites, favoritesCount};
},

addDeal(b = {}) {
if (!b.title ||!String(b.title).trim()) throw Object.assign(new Error('title 必填'), { code: 400});
const deal = insertDeal({
title: String(b.title).trim(), platform: b.platform, category: b.category,
benefit: b.benefit, conditions: b.conditions, link: b.link, notes: b.notes,
expiry_date: b.expiry_date, tags: safeJsonArray(b.tags), play_types: safeJsonArray(b.play_types),
fdv_usd: b.fdv_usd?? null, pool_ratio: b.pool_ratio?? null,
active_addresses: b.active_addresses?? null, worth_cny: b.worth_cny?? null,
});
return { deal};
},

updateDeal(b = {}) {
const cur = db.prepare(`SELECT * FROM deals WHERE id =?`).get(Number(b.id));
if (!cur) throw Object.assign(new Error('deal 不存在'), { code: 404});
const fields = ['title', 'platform', 'category', 'benefit', 'conditions', 'link', 'notes',
'expiry_date', 'status', 'published_at', 'fdv_usd', 'pool_ratio', 'active_addresses', 'worth_cny'];
const sets = [], params = [];
for (const f of fields) {
if (b[f]!== undefined) { sets.push(`${f} =?`); params.push(b[f] === '' && (f === 'link' || f === 'notes' || f === 'expiry_date')? null: b[f]);}
}
if (b.pinned!== undefined) { sets.push(`pinned =?`); params.push(b.pinned? 1: 0);}
if (b.visited!== undefined) {
sets.push(`visited =?`); params.push(b.visited? 1: 0);
sets.push(`visited_at =?`); params.push(b.visited? now(): null);
}
if (b.tags!== undefined) { sets.push(`tags =?`); params.push(toJsonArray(safeJsonArray(b.tags)));}
if (b.play_types!== undefined) { sets.push(`play_types =?`); params.push(toJsonArray(safeJsonArray(b.play_types)));}
// FDV 三参数齐全时重算 est 区间（任一缺失则保持原值）。
const fdv = b.fdv_usd!== undefined? b.fdv_usd: cur.fdv_usd;
const pool = b.pool_ratio!== undefined? b.pool_ratio: cur.pool_ratio;
const active = b.active_addresses!== undefined? b.active_addresses: cur.active_addresses;
const est = calcEst(fdv, pool, active);
if (est) { sets.push(`est_earn_low =?`, `est_earn_high =?`); params.push(est.low, est.high);}
if (b.est_earn_low!== undefined &&!est) { sets.push(`est_earn_low =?`); params.push(b.est_earn_low);}
if (b.est_earn_high!== undefined &&!est) { sets.push(`est_earn_high =?`); params.push(b.est_earn_high);}
sets.push(`updated_at =?`); params.push(now());
if (sets.length > 1) db.prepare(`UPDATE deals SET ${sets.join(', ')} WHERE id =?`).run(...params, Number(b.id));
return { deal: getDeal(b.id)};
},

deleteDeal(b = {}) {
db.prepare(`DELETE FROM deals WHERE id =?`).run(Number(b.id));
return { ok: true};
},

setDealStatus(b = {}) {
const cur = getDeal(b.id);
if (!cur) throw Object.assign(new Error('deal 不存在'), { code: 404});
db.prepare(`UPDATE deals SET status =?, updated_at =? WHERE id =?`).run(b.status, now(), Number(b.id));
return { deal: getDeal(b.id)};
},

setDealPinned(b = {}) {
const cur = getDeal(b.id);
if (!cur) throw Object.assign(new Error('deal 不存在'), { code: 404});
db.prepare(`UPDATE deals SET pinned =?, updated_at =? WHERE id =?`).run(b.pinned? 1: 0, now(), Number(b.id));
return { deal: getDeal(b.id)};
},

setDealVisited(b = {}) {
const cur = getDeal(b.id);
if (!cur) throw Object.assign(new Error('deal 不存在'), { code: 404});
const visited = b.visited? 1: 0;
db.prepare(`UPDATE deals SET visited =?, visited_at =?, updated_at =? WHERE id =?`)
.run(visited, visited? now(): null, now(), Number(b.id));
return { deal: getDeal(b.id)};
},

discoverNow() {
const r = db.prepare(`INSERT INTO discovery_runs (started_at, status, added, skipped) VALUES (?, 'running', 0, 0)`)
.run(now());
const runId = r.lastInsertRowid;
const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'discover.js')], {
detached: true, stdio: 'ignore',
env: {...process.env, DATABASE_PATH: DB_PATH, DISCOVERY_RUN_ID: String(runId)},
});
child.unref();
return { started: true, run_id: runId};
},

getDiscoveryStatus() {
const last = db.prepare(`SELECT * FROM discovery_runs ORDER BY id DESC LIMIT 1`).get();
const running =!!db.prepare(`SELECT 1 FROM discovery_runs WHERE status = 'running' LIMIT 1`).get();
return { running,
last_run: last? { id: last.id, started_at: last.started_at, added: last.added, skipped: last.skipped, status: last.status}: null};
},

saveDiscoveredDeals(b = {}) { return saveDiscovered(b.deals || []);},
importDiscoveredDeals(b = {}) { return saveDiscovered(b.deals || []);},

forwardAirdrops(b = {}) { return forwardAirdrops(b); },

recategorizeDeals() {
  // 只纠正“明显错类”：空投/eSIM 是强规则；其余规则只在当前为 other 时才动，
  // 避免把 airdrop 条目因标题含“插件/AI”等词误移走（空投是重点分类，优先保留）。
  const strongRules = [
    [/空投/i, 'airdrop'], [/eSIM/i, 'esim'],
  ];
  const otherOnlyRules = [
    [/免费云|免费VPS|免费服务器|Oracle|甲骨文/i, 'cloud'],
    [/ChatGPT|Gemini|Claude|Midjourney/i, 'ai'],
    [/银行|信用卡|储蓄卡/i, 'bank'],
    [/话费|流量卡|运营商/i, 'telecom'],
    [/优惠券|折扣|满减/i, 'shopping'],
  ];
  let moved = 0;
  for (const row of db.prepare(`SELECT id, title, category FROM deals`).all()) {
    let target = null;
    for (const [re, cat] of strongRules) if (re.test(row.title)) { target = cat; break; }
    if (!target && row.category === 'other') {
      for (const [re, cat] of otherOnlyRules) if (re.test(row.title)) { target = cat; break; }
    }
    if (target && row.category !== target) {
      db.prepare(`UPDATE deals SET category = ?, updated_at = ? WHERE id = ?`).run(target, now(), row.id);
      moved++;
    }
  }
  return { moved };
},

retagAirdrops() {
  // “补”标签：推断出的玩法与已有 tags/play_types 取并集，不丢原有标签；为空时才补 claim。
  let updated = 0;
  for (const row of db.prepare(`SELECT * FROM deals WHERE category = 'airdrop'`).all()) {
    const inferred = inferPlayTypes(`${row.title} ${row.benefit} ${row.conditions}`);
    const merged = [...new Set([...safeJsonArray(row.tags), ...inferred])];
    const mergedPlay = [...new Set([...safeJsonArray(row.play_types), ...inferred])];
    const tags = JSON.stringify(merged), plays = JSON.stringify(mergedPlay);
    if (row.tags !== tags || row.play_types !== plays) {
      db.prepare(`UPDATE deals SET tags = ?, play_types = ?, updated_at = ? WHERE id = ?`).run(tags, plays, now(), row.id);
      updated++;
    }
  }
  return { updated };
},

enrichAirdropSources() {
return { updated: 0, note: 'legacy no-op'};
},

refreshDealStatuses() {
const r = db.prepare(`UPDATE deals SET status = 'ended', updated_at =? WHERE status = 'todo' AND expiry_date IS NOT NULL AND expiry_date <?`)
.run(now(), todayStr(0));
return { updated: r.changes};
},

getPushSettings() {
const channels = db.prepare(`SELECT * FROM push_channels ORDER BY rowid`).all()
.map((c) => ({ id: c.id, name: c.name, enabled:!!c.enabled,
has_credential:!!(c.credential && c.credential.length > 0),
credential_mask: c.credential? maskCredential(c.credential): ''}));
const prefs = getPrefs();
const admin = db.prepare(`SELECT enabled FROM admin_auth WHERE id = 1`).get();
return { channels,
prefs: { push_interval_hours: prefs.push_interval_hours, new_deals: prefs.new_deals,
only_airdrop: prefs.only_airdrop, only_001: prefs.only_001, expiring_24h: prefs.expiring_24h,
favorite_categories: prefs.favorite_categories, daily_digest: prefs.daily_digest},
admin_required:!!(admin && admin.enabled)};
},

savePushChannel(b = {}) {
const def = CHANNEL_DEFS.find(([id]) => id === b.id);
if (!def) throw Object.assign(new Error(`未知渠道 ${b.id}`), { code: 400});
const cur = db.prepare(`SELECT * FROM push_channels WHERE id =?`).get(b.id);
const enabled = b.enabled!== undefined? (b.enabled? 1: 0): cur.enabled;
// credential 为空字符串表示不改已存凭据；只有非空才覆盖。
const credential = (b.credential!== undefined && b.credential!== '')? b.credential: cur.credential;
db.prepare(`UPDATE push_channels SET enabled =?, credential =? WHERE id =?`).run(enabled, credential, b.id);
const row = db.prepare(`SELECT * FROM push_channels WHERE id =?`).get(b.id);
return { channel: { id: row.id, name: row.name, enabled:!!row.enabled,
has_credential:!!(row.credential && row.credential.length > 0),
credential_mask: row.credential? maskCredential(row.credential): ''}};
},

savePushPrefs(b = {}) {
const p = b.prefs || b;
const interval = [1, 6, 8, 12, 24].includes(Number(p.push_interval_hours))? Number(p.push_interval_hours): 6;
const bool = (v, cur) => (v === undefined? cur: (v? 1: 0));
const cur = db.prepare(`SELECT * FROM push_prefs WHERE id = 1`).get();
db.prepare(`UPDATE push_prefs SET push_interval_hours =?, new_deals =?, only_airdrop =?, only_001 =?,
expiring_24h =?, favorite_categories =?, daily_digest =? WHERE id = 1`)
.run(interval, bool(p.new_deals, cur.new_deals), bool(p.only_airdrop, cur.only_airdrop),
bool(p.only_001, cur.only_001), bool(p.expiring_24h, cur.expiring_24h),
bool(p.favorite_categories, cur.favorite_categories), bool(p.daily_digest, cur.daily_digest));
return { prefs: actions.getPushSettings().prefs};
},

async testPushChannel(b = {}) {
const ch = db.prepare(`SELECT * FROM push_channels WHERE id =?`).get(b.id);
if (!ch) throw Object.assign(new Error(`未知渠道 ${b.id}`), { code: 400});
if (!ch.credential) return { ok: false, message: '还没填凭据'};
const r = await sendToChannel(ch, '测试推送', '这是一条测试消息，说明该渠道可以正常收到推送。');
logPush(ch.id, 'test', r.ok, r.message);
return r;
},

async sendDailyDigest() {
const prefs = getPrefs();
if (!prefs.daily_digest) return { sent: 0, skipped: enabledChannels().length, note: 'daily_digest 未开启'};
const since = now() - 24 * 3600 * 1000;
let list = db.prepare(`SELECT * FROM deals WHERE created_at >=? ORDER BY id DESC`).all(since).map(dealOut);
list = filterForPrefs(list, prefs);
if (list.length === 0) return { sent: 0, skipped: 0, note: '最近 24 小时无新增条目'};
const text = `最近 24 小时新增 ${list.length} 条：\n` + list.slice(0, 20).map(dealLine).join('\n');
const r = await pushToEnabled('每日汇总', text, 'digest');
return { sent: r.sent, skipped: r.skipped};
},

async sendExpiringAlerts() {
const tomorrow = todayStr(1);
const list = db.prepare(
`SELECT * FROM deals WHERE status='todo' AND expiry_date IS NOT NULL AND expiry_date >=? AND expiry_date <=? ORDER BY expiry_date ASC`)
.all(todayStr(0), tomorrow).map(dealOut);
if (list.length === 0) return { sent: 0, skipped: 0, note: '24 小时内无到期条目'};
const text = `24 小时内到期 ${list.length} 条：\n` + list.map((d) => `· ${d.title}（${d.expiry_date} 到期）${d.link? '\n ' + d.link: ''}`).join('\n');
const r = await pushToEnabled('即将到期提醒', text, 'expiring');
return { sent: r.sent, skipped: r.skipped};
},

async flushPendingPushes() {
const prefs = getPrefs();
const intervalMs = prefs.push_interval_hours * 3600 * 1000;
const last = prefs.last_flush_at || 0;
if (last && now() - last < intervalMs) return { due: false, sent: 0};
const since = last || (now() - intervalMs);
let list = db.prepare(`SELECT * FROM deals WHERE created_at >? ORDER BY id DESC`).all(since).map(dealOut);
if (!prefs.new_deals &&!last) list = []; // 从未设置过水位且未开启新条目推送时，不补推旧数据
list = filterForPrefs(list, prefs);
db.prepare(`UPDATE push_prefs SET last_flush_at =? WHERE id = 1`).run(now());
if (list.length === 0) return { due: true, sent: 0};
const text = `新增 ${list.length} 条：\n` + list.slice(0, 20).map(dealLine).join('\n');
const r = await pushToEnabled('新羊毛', text, 'flush');
return { due: true, sent: r.sent};
},

getProxySettings() {
const row = db.prepare(`SELECT * FROM proxy_settings WHERE id = 1`).get();
if (!row) return { enabled: false, type: 'http', host: '', port: 7890, username: '', has_password: false};
return { enabled:!!row.enabled, type: row.type, host: row.host, port: row.port,
username: row.username, has_password:!!(row.password && row.password.length > 0)};
},

saveProxySettings(b = {}) {
const cur = db.prepare(`SELECT * FROM proxy_settings WHERE id = 1`).get();
const password = (b.password!== undefined && b.password!== '')? b.password: (cur?.password?? null);
db.prepare(`INSERT INTO proxy_settings (id, enabled, type, host, port, username, password)
VALUES (1,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, type=excluded.type, host=excluded.host,
port=excluded.port, username=excluded.username, password=excluded.password`)
.run(b.enabled? 1: 0, ['http', 'socks5'].includes(b.type)? b.type: 'http',
b.host || '', Number(b.port) || 7890, b.username || '', password);
return actions.getProxySettings();
},

async testProxy() {
const s = actions.getProxySettings();
if (!s.host) return { ok: false, message: '还没填代理 host'};
return await new Promise((resolve) => {
const sock = net.connect({ host: s.host, port: s.port, timeout: 5000});
const done = (ok, message) => { try { sock.destroy();} catch { /* ignore */} resolve({ ok, message});};
sock.once('connect', () => done(true, `TCP 连接 ${s.host}:${s.port} 成功`));
sock.once('timeout', () => done(false, `连接 ${s.host}:${s.port} 超时（5s）`));
sock.once('error', (e) => done(false, `连接 ${s.host}:${s.port} 失败：${e.code || ''} ${e.message}`));
});
},
};

// saveDiscoveredDeals / importDiscoveredDeals 共用：逐条去重入库。
function saveDiscovered(list) {
let added = 0, skipped = 0;
for (const d of Array.isArray(list)? list: []) {
if (!d ||!d.title) { skipped++; continue;}
let exists;
if (d.link) {
exists = db.prepare(`SELECT id FROM deals WHERE link =? LIMIT 1`).get(d.link);
} else {
exists = db.prepare(`SELECT id FROM deals WHERE title =? AND conditions =? LIMIT 1`)
.get(d.title, d.conditions || '');
}
if (exists) {
  // 幂等 upsert：来源带已看/置顶/状态时同步到已有记录（种子导入跨设备同步用）
  const sets = [], params = [];
  if (d.visited === true) { sets.push('visited = 1');
    sets.push('visited_at = ?'); params.push(d.visited_at ? Number(d.visited_at) || now() : now()); } // 只标已看，不回退
  if (d.pinned !== undefined) { sets.push('pinned = ?'); params.push(d.pinned ? 1 : 0); }
  if (d.status !== undefined && d.status) { sets.push('status = ?'); params.push(d.status); }
  if (sets.length) db.prepare(`UPDATE deals SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, now(), exists.id);
  skipped++; continue;
}
const tags = d.tags?.length? d.tags: undefined;
const play = d.play_types?.length? d.play_types: undefined;
insertDeal({ title: d.title, platform: d.platform, category: d.category,
benefit: d.benefit, conditions: d.conditions, link: d.link, notes: d.notes,
expiry_date: d.expiry_date, tags, play_types: play,
visited: d.visited, visited_at: d.visited_at, pinned: d.pinned, status: d.status,
fdv_usd: d.fdv_usd?? null, pool_ratio: d.pool_ratio?? null,
active_addresses: d.active_addresses?? null, worth_cny: d.worth_cny?? null,
forwarded_ctp: 0});
added++;
}
if (added > 0) {
  // 有新线报入库 → 3 秒后把空投类转发给空投看板（失败只记日志，不影响入库）
  setTimeout(() => { forwardAirdrops().catch((e) => console.error('[ctp-forward]', e.message)); }, 3000);
}
return { added, skipped};
}

// ---------- HTTP 服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/health') {
      const deals = db.prepare(`SELECT COUNT(*) c FROM deals`).get().c;
      return sendJson(res, 200, { ok: true, deals });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const action = pathname.slice('/api/'.length).split('/')[0];
      if (!actions[action]) return sendJson(res, 400, { ok: false, error: `未知动作：${action}` });
      let body = {};
      const raw = await readBody(req);
      if (raw.trim()) { try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); } }
      const result = await actions[action](body && typeof body === 'object' ? body : {});
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET') {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' };
        if (file.endsWith('.html')) headers['Cache-Control'] = 'no-cache';
        res.writeHead(200, headers);
        fs.createReadStream(file).pipe(res);
        return;
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }

    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return sendJson(res, e?.code || 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`yangmao-tool listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
});

// 种子文件监视：data/deals-seed.json 内容变化（mtime 变化）即自动 upsert 导入。
// 用途：外部（GitHub 同步）更新种子后，更新中心拉代码落盘 → 服务自动把新增/已看状态导入库，幂等。
function importSeedIfChanged() {
  try {
    const f = path.join(__dirname, 'data', 'deals-seed.json');
    if (!fs.existsSync(f)) return;
    const m = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (getMeta('seed_hash') === m) return;
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(list) || !list.length) { setMeta('seed_hash', m); return; }
    const r = saveDiscovered(list);
    setMeta('seed_hash', m);
    console.log(`[seed] 种子导入：新增 ${r.added} 条，重复/同步 ${r.skipped} 条`);
  } catch (e) {
    console.error('[seed]', e.message);
  }
}
importSeedIfChanged(); // 启动即检查一次（覆盖更新中心刚部署完的场景）
setInterval(importSeedIfChanged, 10 * 60 * 1000);

// 启动后 15s 及每 30 分钟：把未转发的空投推给看板（幂等，forwarded_ctp 已标记的会跳过）
setTimeout(() => { forwardAirdrops().catch((e) => console.error('[ctp-forward]', e.message)); }, 15000);
setInterval(() => { forwardAirdrops().catch((e) => console.error('[ctp-forward]', e.message)); }, 30 * 60 * 1000);
