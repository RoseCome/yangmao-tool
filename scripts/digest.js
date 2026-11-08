// 定时任务：发送每日汇总 + 即将到期提醒。
// 用法：node scripts/digest.js（端口读 PORT 环境变量，默认 3000）。
const PORT = Number(process.env.PORT || 3000);
for (const action of ['sendDailyDigest', 'sendExpiringAlerts']) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const data = await res.json();
  console.log(action, JSON.stringify(data));
  if (!res.ok || data.ok === false) process.exit(1);
}
