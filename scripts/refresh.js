// 定时任务（09:00 / 21:00）：先跑一轮自动发现（抓 airdrops.io，入库 + 自动转发看板），
// 等发现结束后再刷新条目状态（把已过期的 todo 改为 ended）。
const PORT = Number(process.env.PORT || 3000);
const post = (a, body = {}) => fetch(`http://127.0.0.1:${PORT}/api/${a}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 触发发现
const d = await post('discoverNow');
console.log('discoverNow:', JSON.stringify(d));

// 2. 等发现结束（最多 4 分钟）
if (d.started) {
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const s = await post('getDiscoveryStatus');
    if (!s.running) { console.log('discovery finished:', JSON.stringify(s.last || s)); break; }
  }
}

// 3. 拉取 GitHub 上最新种子（外部设备每 6h 推一次；公开仓库 raw 下载无需凭据）。
//    落盘后由 server 的种子监视器在 10 分钟内自动 upsert 导入。
try {
  const r = await fetch('https://raw.githubusercontent.com/RoseCome/yangmao-tool/main/data/deals-seed.json');
  if (r.ok) {
    const txt = await r.text();
    const list = JSON.parse(txt);
    if (Array.isArray(list) && list.length) {
      const fs = await import('node:fs');
      const cur = fs.existsSync('data/deals-seed.json') ? fs.readFileSync('data/deals-seed.json', 'utf8') : '';
      if (txt !== cur) {
        fs.writeFileSync('data/deals-seed.json', txt);
        console.log('seed pulled from GitHub:', list.length, 'deals');
      } else console.log('seed unchanged');
    }
  } else console.log('seed fetch skipped: HTTP', r.status);
} catch (e) { console.log('seed fetch failed:', e.message); }

// 4. 刷新过期状态
const res = await post('refreshDealStatuses');
console.log('refreshDealStatuses:', JSON.stringify(res));
if (res.ok === false) process.exit(1);
