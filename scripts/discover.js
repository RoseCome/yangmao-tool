// 空投/线报自动发现 · 多源版
// 来源（2026-11 实测可直连抓取；403/停放的聚合站不收录，不编造数据）：
//   airdrops.io  最新 5 页 + confirmed/telegram/hot/testnet 分类页（WordPress 服务端渲染）
//   t.me/s/airdrops_io       airdrops.io 官方电报频道（空投快讯）
//   t.me/s/airdropalertcom   AirdropAlert 官方电报频道（空投快讯）
//   t.me/s/zuanke8           赚客吧官方电报频道（中文羊毛线报）
// 入库走服务端 /api/saveDiscoveredDeals（去重、转发空投看板都在服务端做）。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/app.db');
const PORT = Number(process.env.PORT || 3000);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';

// ---------- airdrops.io ----------
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
function parseAirdropsIo(html) {
  // split 后每段开头还带着 article 的属性串，先切掉第一个 '>' 之后才是正文
  const arts = html.split('<article').slice(1).map((a) => a.slice(a.indexOf('>') + 1));
  const items = [];
  for (const a of arts) {
    const h = a.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/);
    if (!h) continue;
    const name = h[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (!name || /latest airdrops/i.test(name)) continue;
    const link = a.match(/href="(https:\/\/airdrops\.io\/[a-z0-9-]+\/)"/i);
    if (!link || /\/(visit|blog|airdrop-alert)\//.test(link[1])) continue;
    const plain = a.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const am = plain.match(/Actions:\s*([^]*?)CLAIM AIRDROP/i);
    const actions = am ? am[1].split(/,|&/).map((x) => x.trim()).filter(Boolean).slice(0, 6) : [];
    const brief = plain.replace(/^[^A-Za-z\u4e00-\u9fff]{0,20}/, '').slice(0, 140);
    items.push({ name, url: link[1], actions, confirmed: /Confirmed/i.test(plain), ongoing: /Ongoing/i.test(plain), brief });
  }
  return items;
}

// ---------- Telegram 频道预览页 ----------
function unescapeText(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#036;/g, '$').replace(/&#39;/g, "'");
}
function tgCleanText(body) {
  let t = body.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '');
  t = unescapeText(t);
  return t.replace(/\n{2,}/g, '\n').trim();
}
function parseTelegram(html) {
  const blocks = html.split('<div class="tgme_widget_message ');
  const items = [];
  for (const b of blocks.slice(1)) {
    const pid = b.match(/data-post="([^"]+)"/);
    if (!pid) continue;
    const m = b.match(/tgme_widget_message_text js-message_text" dir="auto">([\s\S]*?)<\/div>/);
    if (!m) continue;
    const ext = b.match(/href="(https?:\/\/(?!t\.me\/|telegram\.me\/)[^"]+)"/);
    items.push({ id: pid[1], text: tgCleanText(m[1]), extLink: ext ? ext[1] : null });
  }
  return items;
}

// 中文线报分类（按内容关键词，与服务端 recategorize 规则一致）
function classifyZh(text) {
  const rules = [
    [/空投/i, 'airdrop'], [/eSIM|esim/i, 'esim'],
    [/话费|流量|运营商|移动|联通|电信/i, 'telecom'],
    [/银行|工行|建行|农行|中行|信用卡/i, 'bank'],
    [/ChatGPT|GPT|Gemini|Claude|人工智能/i, 'ai'],
    [/云服务器|VPS|免费服务器|甲骨文|Oracle/i, 'cloud'],
    [/抽奖|免单|优惠券|红包|立减|满减|京东|淘宝|拼多多|美团|外卖/i, 'shopping'],
    [/脚本|插件|工具|接码/i, 'scripts'],
  ];
  for (const [re, cat] of rules) if (re.test(text)) return cat;
  return 'other';
}

function fetchTxt(url) {
  return fetch(url, { headers: { 'user-agent': UA, 'Accept-Language': 'en,zh;q=0.8' }, signal: AbortSignal.timeout(20000) })
    .then(async (r) => { if (!r.ok) throw new Error(`${url} HTTP ${r.status}`); return r.text(); });
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
  const summary = [];
  try {
    const deals = [];
    const seen = new Set();
    const add = (d) => { if (d && d.link && !seen.has(d.link)) { seen.add(d.link); deals.push(d); } };

    // 1) airdrops.io（9 个页面）
    const ioPages = [
      'https://airdrops.io/latest/', 'https://airdrops.io/latest/page/2/', 'https://airdrops.io/latest/page/3/',
      'https://airdrops.io/latest/page/4/', 'https://airdrops.io/latest/page/5/',
      'https://airdrops.io/confirmed/', 'https://airdrops.io/telegram/', 'https://airdrops.io/hot/', 'https://airdrops.io/testnet/',
    ];
    let ioOk = 0;
    await Promise.allSettled(ioPages.map(async (u) => {
      const items = parseAirdropsIo(await fetchTxt(u));
      if (items.length) ioOk++;
      for (const it of items) {
        add({
          title: `空投 ${it.name}${it.confirmed ? '（已确认）' : it.ongoing ? '（进行中）' : ''}`,
          platform: `${it.name} / airdrops.io`,
          category: 'airdrop', status: 'todo',
          benefit: it.brief || (it.confirmed ? '官方已确认的空投活动' : 'airdrops.io 收录的空投活动'),
          conditions: it.actions.length ? it.actions.map(zhAction).join('；') : '打开活动页按提示完成任务',
          link: it.url, expiry_date: null, tags: ['airdrops.io'],
        });
      }
    }));
    summary.push(`airdrops.io ${ioOk}/9 页`);

    // 2) Telegram 空投频道
    const AIRDROP_KW = /airdrop|claim|confirmed|reward|points|testnet|tge|snapshot|air drop|空投/i;
    const tgChannels = ['airdrops_io', 'airdropalertcom'];
    let tgOk = 0;
    await Promise.allSettled(tgChannels.map(async (ch) => {
      const msgs = parseTelegram(await fetchTxt(`https://t.me/s/${ch}`));
      const kept = msgs.filter((m) => m.text.length >= 40 && AIRDROP_KW.test(m.text));
      if (kept.length) tgOk++;
      for (const m of kept) {
        const first = m.text.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 60);
        add({
          title: `空投速报：${first}`,
          platform: `Telegram @${ch}`,
          category: 'airdrop', status: 'todo',
          benefit: m.text.slice(0, 300),
          conditions: m.extLink ? `打开消息中的项目链接参与：${m.extLink}` : '打开消息查看参与方式',
          link: `https://t.me/${m.id}`, expiry_date: null, tags: ['telegram', ch],
        });
      }
    }));
    summary.push(`电报空投频道 ${tgOk}/2`);

    // 3) 赚客吧中文线报频道
    const ZK_KW = /http|#小程序|#公众号|红包|优惠券|立减|免单|抽奖|羊毛|白嫖|活动|领取|注册/;
    try {
      const msgs = parseTelegram(await fetchTxt('https://t.me/s/zuanke8'));
      const kept = msgs.filter((m) => m.text.length >= 20 && ZK_KW.test(m.text));
      summary.push(`赚客吧 ${kept.length}/${msgs.length} 条`);
      for (const m of kept) {
        const first = m.text.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 60);
        add({
          title: `线报：${first}`,
          platform: 'Telegram @zuanke8',
          category: classifyZh(m.text), status: 'todo',
          benefit: m.text.slice(0, 300),
          conditions: m.extLink ? `打开链接参与：${m.extLink}` : '按线报内容操作（详见消息）',
          link: `https://t.me/${m.id}`, expiry_date: null, tags: ['telegram', 'zuanke8'],
        });
      }
    } catch (e) { summary.push(`赚客吧失败(${String(e?.message || e).slice(0, 40)})`); }

    console.log(`[discover] 抓取汇总：${summary.join('，')}，去重后待入库 ${deals.length} 条`);
    if (!deals.length) { finish({ status: 'done', note: `各源均未抓到条目：${summary.join('，')}` }); return; }

    const resp = await fetch(`http://127.0.0.1:${PORT}/api/saveDiscoveredDeals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deals }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error('saveDiscoveredDeals HTTP ' + resp.status + ' ' + JSON.stringify(data).slice(0, 200));
    const added = Number(data.added ?? 0);
    const skipped = Number(data.skipped ?? 0);
    console.log(`[discover] 入库 ${added} 条，跳过重复 ${skipped} 条`);
    finish({ status: 'done', added, skipped, note: `多源扫描：${summary.join('，')}` });
  } catch (e) {
    console.error('[discover] 失败:', e?.message || e);
    finish({ status: 'failed', note: String(e?.message || e).slice(0, 200) });
    process.exitCode = 1;
  }
}

main();
