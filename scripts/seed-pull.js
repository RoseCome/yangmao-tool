// 独立种子同步任务（每 6 小时由 yangmao-seedpull.timer 触发）：
// 从 GitHub raw 拉最新 data/deals-seed.json 落盘。
// 落盘后由 server 的种子监视器（10 分钟 sha256 指纹检测）自动 upsert 导入，无需重启。
// 公开仓库 raw 下载无需凭据；文件未变化时直接跳过（无副作用）。
const SEED_URL = 'https://raw.githubusercontent.com/RoseCome/yangmao-tool/main/data/deals-seed.json';
const dest = 'data/deals-seed.json';

try {
  const r = await fetch(SEED_URL);
  if (!r.ok) { console.log('[seed-pull] HTTP', r.status, '- skipped'); process.exit(0); }
  const txt = await r.text();
  const list = JSON.parse(txt);
  if (!Array.isArray(list) || !list.length) { console.log('[seed-pull] empty/invalid, skip'); process.exit(0); }
  const fs = await import('node:fs');
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  if (txt === cur) { console.log('[seed-pull] unchanged'); process.exit(0); }
  fs.writeFileSync(dest, txt);
  console.log('[seed-pull] updated:', list.length, 'deals');
} catch (e) {
  console.error('[seed-pull] failed:', e.message);
  process.exit(1);
}
