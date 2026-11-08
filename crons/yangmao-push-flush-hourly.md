# 全网羊毛 · 每小时推送水位检查

- **调度**：每小时跑一次。
- **做什么**：调用 `POST /api/flushPendingPushes`，按 `push_prefs` 里存的 `last_flush_at` 水位和 `push_interval_hours`（1/6/8/12/24 小时可选，默认 6 小时）判断：未到间隔返回 `{due:false, sent:0}`，什么都不推；到了间隔则把期间新增的、符合推送偏好（仅空投 / 收藏分类等）的条目推给已启用的渠道，并推进水位。
- **调用**：`node scripts/flush.js`（内部调 `POST /api/flushPendingPushes`，端口读 `PORT` 环境变量，默认 3000）
- **注意**：推送总开关与各渠道启用状态在页面「推送设置」里改；没有启用任何渠道时 `sent` 为 0，不报错。
