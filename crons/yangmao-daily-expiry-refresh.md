# 全网羊毛 · 每日过期状态刷新

- **调度**：每天跑一次（建议 0:30）。
- **做什么**：把 `status=todo` 且 `expiry_date` 小于今天的条目改为 `ended`，避免已过期的羊毛继续出现在可领列表里；同时可顺带触发每日汇总与到期提醒（见 `scripts/digest.js`）。
- **调用**：
  - 刷新状态：`node scripts/refresh.js`（内部调 `POST /api/refreshDealStatuses`，端口读 `PORT` 环境变量，默认 3000）
  - 或直接调接口：`curl -X POST http://127.0.0.1:3000/api/refreshDealStatuses -H 'Content-Type: application/json' -d '{}'`
- **返回**：`{updated}` 为本次改为 `ended` 的条数。
