// 定时任务：刷新条目状态（把已过期的 todo 条目改为 ended）。
// 用法：node scripts/refresh.js（端口读 PORT 环境变量，默认 3000）。
const PORT = Number(process.env.PORT || 3000);
const res = await fetch(`http://127.0.0.1:${PORT}/api/refreshDealStatuses`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
const data = await res.json();
console.log(JSON.stringify(data));
if (!res.ok || data.ok === false) process.exit(1);
