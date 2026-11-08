// 定时任务：按推送间隔水位，把期间新增的条目推给已启用的渠道。
// 用法：node scripts/flush.js（端口读 PORT 环境变量，默认 3000）。
const PORT = Number(process.env.PORT || 3000);
const res = await fetch(`http://127.0.0.1:${PORT}/api/flushPendingPushes`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
const data = await res.json();
console.log(JSON.stringify(data));
if (!res.ok || data.ok === false) process.exit(1);
