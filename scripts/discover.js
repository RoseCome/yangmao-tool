// 空投自动发现：抓 airdrops.io 最新列表（前 3 页），解析成线报入库。
// 入库走服务端 /api/saveDiscoveredDeals（去重、触发转发给空投看板都在服务端做）。
// 不编造条目：抓不到、解析不出就如实记 0。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/app.db');
const PORT = Number(process.env.PORT || 3000);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';

const ACTION_ZH = [
  [/^(telegram|t\.me)$/i, '加入官方电报群（Telegram）'],
  [/^(discord)$/i, '加入官方 Discord 服务器'],
  [/^(x|twitter|x\/twitter)$/i, '关注官方 X（推特）账号'],
  [/join (the )?(community|discord|telegram)/i, '加入官方社群（Discord / Telegram）'],
  [/follow .*x|follow on x|follow twitter/i, '关注官方 X（推特）账号'],
  [/retweet|repost|quote/i, '转发官方推文'],
  [/like|comment/i, '点赞并留言'],
  [/link wallet|connect wallet|connect/i, '连接钱包'],
  [/stake|staking/i, '质押代币'],
  [/deposit/i, '存入资产'],
  [/trade|swap/i, '做一笔交易（兑换）'],
  [/bridge/i, '跨链桥接资产'],
  [/refer|invite/i, '邀请好友赚推荐奖励'],
  [/leaderboard/i, '冲排行榜提高积分'],
  [/earn xp|xp/i, '做任务攒经验值'],
  [/badge|role/i, '领取身份徽章 / 角色'],
  [/claim/i, '领取空投'],
  [/mint/i, '铸造 NFT / 徽章'],
  [/testnet/i, '参与测试网交互'],
  [/hold/i, '持有代币满足快照'],
  [/vote|governance/i, '参与治理投票'],
  [/quiz|answer/i, '完成问答'],
  [/register|sign ?up|create account/i, '注册账号'],
  [/complete quests?/i, '完成平台任务（Quests）'],
  [/complete social tasks?/i, '完成社交任务（关注、转发等）'],
  [/fund wallet|deposit funds?/i, '给钱包充值（入金）'],
  [/sign ?in|log ?in/i, '登录平台账号'],
  [/create post|post about/i, '发布一条帖子'],
  [/play games?/i, '玩平台小游戏'],
  [/collect .*points/i, '收集平台积分'],
  [/mine /i, '挖矿攒积分 / 代币'],
  [/use the .+ platform/i, '使用该平台完成一次交互'],
  [/join .+ drop/i, '参加官方空投活动页'],
  [/quest/i, '完成平台任务（Quests）'],
];

function zhAction(raw) {
  for (const [re, zh] of ACTION_ZH) if (re.test(raw)) return zh;
  return `完成「${raw}」操作（详情见项目页）`;
}

function parseAirdropsHtml(html) {
  // split 后每段开头还带着 article 的属性串，先切掉第一个 '>' 之后才是正文
  const arts = html.split('<article').slice(1).map((a) => a.slice(a.indexOf('>') + 1));
  const items = [];
  for (const a of arts) {
    const h = a.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/);
    if (!h) continue;
    const name = h[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (!name || /latest airdrops/i.test(name)) continue;
    const link = a.match(/href="(https:\/\/airdrops\.io\/[a-z0-9-]+\/)"/i);
    if (!link) continue;
    const plain = a.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const am = plain.match(/Actions:\s*([^]*?)CLAIM AIRDROP/i);
    const actions = am ? am[1].split(/,|&/).map((x) => x.trim()).filter(Boolean).slice(0, 6) : [];
    const confirmed = /Confirmed/i.test(plain);
    const ongoing = /Ongoing/i.test(plain);
    const brief = plain.replace(/^[^A-Za-z\u4e00-\u9fff]{0,20}/, '').slice(0, 140);
    items.push({ name, url: link[1], actions, confirmed, ongoing, brief });
  }
  return items;
}

async function fetchPage(url) {
  const resp = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return parseAirdropsHtml(await resp.text());
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const runId = process.env.DISCOVERY_RUN_ID ? Number(process.env.DISCOVERY_RUN_ID) : null;
  const finish = (patch) => {
    if (!runId) return;
    const cur = db.prepare(`SELECT note FROM discovery_runs WHERE id = ?`).get(runId) || {};
    db.prepare(`UPDATE discovery_runs SET status = ?, finished_at = ?, added = ?, skipped = ?, note = ? WHERE id = ?`)
      .run(patch.status, Date.now(), patch.added ?? 0, patch.skipped ?? 0,
        [cur.note, patch.note].filter(Boolean).join(' | ') || null, runId);
  };
  try {
    const pages = ['https://airdrops.io/latest/', 'https://airdrops.io/latest/page/2/', 'https://airdrops.io/latest/page/3/'];
    const results = await Promise.allSettled(pages.map(fetchPage));
    const seen = new Set();
    const items = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') { console.error('[discover] 页面抓取失败:', r.reason?.message || r.reason); continue; }
      for (const it of r.value) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
    }
    console.log(`[discover] 抓到 ${items.length} 条（${results.filter(r => r.status === 'fulfilled').length}/3 页成功）`);
    if (!items.length) { finish({ status: 'done', note: 'airdrops.io 未抓到条目' }); return; }

    const deals = items.map((it) => ({
      title: `空投 ${it.name}${it.confirmed ? '（已确认）' : it.ongoing ? '（进行中）' : ''}`,
      platform: `${it.name} / airdrops.io`,
      category: 'airdrop',
      status: 'todo',
      benefit: it.brief || (it.confirmed ? '官方已确认的空投活动' : 'airdrops.io 收录的空投活动'),
      conditions: it.actions.length ? it.actions.map(zhAction).join('；') : '打开活动页按提示完成任务',
      link: it.url,
      expiry_date: null,
      tags: ['airdrops.io'],
    }));

    // 服务端入库（link 去重 + 自动转发给空投看板都在服务端完成）
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/saveDiscoveredDeals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deals }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error('saveDiscoveredDeals HTTP ' + resp.status + ' ' + JSON.stringify(data).slice(0, 200));
    const added = Number(data.added ?? 0);
    const skipped = Number(data.skipped ?? 0);
    console.log(`[discover] 入库 ${added} 条，跳过重复 ${skipped} 条`);
    finish({ status: 'done', added, skipped, note: `airdrops.io 扫描 ${items.length} 条` });
  } catch (e) {
    console.error('[discover] 失败:', e?.message || e);
    finish({ status: 'failed', note: String(e?.message || e).slice(0, 200) });
    process.exitCode = 1;
  }
}

main();
