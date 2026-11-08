# 全网羊毛工作空间（自部署版）

自己用的白嫖 / 线报聚合工具：展示为主，空投是重点（能赚钱），其他羊毛只是娱乐。
本项目是按功能清单重新写的独立实现，不依赖任何托管平台，Node 20+ 就能跑，零外部依赖。

## 功能

- 羊毛列表：最新在上、无限滚动（每次 20 条）、搜索、分类筛选、只看收藏、隐藏已看、点击标题标为已看（整张变灰）
- 空投：独立分类，9 种玩法标签筛选（领取 / 积分 / 测试网 / 挂机节点 / 水龙头 / 钱包连接 / 插件 / 铸造 / 推荐拉人头）
- 预估收益：FDV 反推模型，`单号预估 = FDV × 空投总池比例 ÷ 净活跃地址 × 权重`，
  权重三档：基础合格 1.0x、深度活跃 1.5x、核心贡献 2.5x；缺参数显示“待定”，不编数字
- 空投收益测算器：输入 FDV、池比例、净活跃地址、权重、账号数（1/2/3/5/10），实时算单号与多账号总产出
  （汇率 7.24），四档赛道参考值一键填入；仅作投研与 ROI 规划参考
- 推送设置：无管理员口令（仅自己用），8 个渠道（企业微信、钉钉、飞书、Telegram Bot、Server酱 Turbo、
  PushPlus、Bark、Discord），凭据只显示掩码；推送频率 1 / 6 / 8 / 12 / 24 小时可选，默认 6 小时
  （改频率只改推送节奏，不改发现节奏）
- 代理设置：HTTP / SOCKS5、地址、端口、用户名密码、测试代理；给私有化部署准备
- “立即发现”：手动触发一轮全网搜索（见 `scripts/discover.js` 说明）
- 亮色默认，深色切换在右下角小圆钮

## 怎么跑

```bash
npm install   # 零依赖，实际上什么都不用装；无网络也能跳过这步
npm start     # 默认 http://127.0.0.1:3000
```

环境变量（见 `.env.example`）：

- `PORT`：默认 3000
- `DATABASE_PATH`：默认 `./data/app.db`
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`：代理（部署到 NAS 后填 NAS 上 Clash / V2Ray 的局域网地址）

数据库在 `./data/app.db`，已内置 157 条种子数据（2026-11-08 快照）。备份 = 直接复制这个文件。
`.gitignore` 已排除 `data/app.db` 与 `.env`——库内凭据是明文存储的，不要提交、不要发公开渠道。

## Docker 部署（推荐，只绑局域网）

```bash
cp .env.example .env   # 按需填代理
docker compose up -d
```

`docker-compose.yml` 只绑局域网示例地址 `192.168.1.10:3000`，请改成你 NAS / 服务器的局域网 IP，
**不要写 `0.0.0.0`、不要做端口转发、不要暴露公网**。浏览器打开 `http://192.168.1.10:3000` 即可。
数据目录 `./data` 已映射为卷，备份 = 复制卷里的 `.sqlite` 文件。

## 代理怎么配

两种配法（任选一种，页面里填的优先）：

- 页面里填：打开空间 → 左栏「代理设置」→ 启用 → 选 HTTP 或 SOCKS5 → 填代理地址和端口
  （NAS 上 Clash 默认 7890，V2Ray 自查端口）→ 可选用户名/密码 → 保存 → 点「测试代理」
  （测试会真的去连接代理地址看通不通）。
- 环境变量：在 `.env` 里加 `HTTP_PROXY=http://192.168.1.10:7890` 等。

注意：代理地址填的是**你 NAS 上 Clash / V2Ray 的局域网地址**，不是远程代理服务。
托管版跑在云端时填局域网代理是连不上的，这是正常的，代理功能就是给私有化部署准备的。

## 推送怎么配

打开空间 →「推送设置」（已放开，无管理员口令）：

1. 先填至少一个渠道的凭据（凭据填在页面里，不要写进聊天记录、不要写进仓库）。
   Telegram 凭据格式为 `token|chat_id`（Bot Token 和聊天 ID 用 `|` 隔开）。
2. 点「测试推送」，收到测试消息后再开内容偏好。
3. 内容偏好默认全关：新线报 / 只推空投 / 只推 0.01 撸 / 快到期 24 小时 / 收藏的分类 / 每天 9 点汇总一条。
4. 推送频率 1 / 6 / 8 / 12 小时或每天 1 次，默认 6 小时。

## 定时任务（4 项，部署后在目标机上重建）

| 任务 | 调度 | 做法 |
|---|---|---|
| 自动发现 | 每 6 小时 | 跑 `node scripts/discover.js`（见下文说明），或用 cron / 青龙面板定时触发 |
| 过期刷新 | 每天 09:00 | `node scripts/refresh.js`（调 `refreshDealStatuses`） |
| 每日汇总 + 快到期提醒 | 每天 09:00 / 09:05 | `node scripts/digest.js`（调 `sendDailyDigest` + `sendExpiringAlerts`） |
| 每小时补推 | 每小时 | `node scripts/flush.js`（调 `flushPendingPushes`，按推送频率水位补推） |

定时任务的完整任务正文见 `crons/` 目录（发现任务含 FDV 模型、玩法标签、论坛来源等口径）。

## 关于自动发现（重要，如实说明）

`scripts/discover.js` 目前是**占位实现**：它只会把当轮状态写为完成，不往库里写任何条目。
原因：真正的自动发现需要在网上搜索、核对来源后才能入库，编造条目是绝不允许的。
要让它真的自动发现，需要接一个有搜索能力的任务执行器（或人工跑一轮搜索核对后调用
`POST /api/saveDiscoveredDeals` 入库，接口已实现，含去重、玩法推断、FDV 收益反推）。
发现口径见 `crons/yangmao-6h-discovery.md`：只收免费/白嫖，空投是重点，英文来源为主，
论坛内容可取但论坛链接不入库，不提交注册、不填用户手机号/邮箱、不用接码号。

## 接口（27 个，POST /api/:action，JSON）

列表与查看：`listDeals`、`getDealStats`、`getSidebarData`；
增删改：`addDeal`、`updateDeal`、`deleteDeal`、`setDealStatus`、`setDealPinned`、`setDealVisited`；
发现：`discoverNow`、`getDiscoveryStatus`、`saveDiscoveredDeals`、`importDiscoveredDeals`、
`recategorizeDeals`、`retagAirdrops`、`enrichAirdropSources`（遗留兼容，无实际作用）；
过期与推送：`refreshDealStatuses`、`getPushSettings`、`savePushChannel`、`savePushPrefs`、
`testPushChannel`、`sendDailyDigest`、`sendExpiringAlerts`、`flushPendingPushes`；
代理：`getProxySettings`、`saveProxySettings`、`testProxy`。

## 数据说明

- 种子数据：157 条（2026-11-08 快照），分类：AI 额度 48、空投 43、脚本 27、eSIM 19、购物 7、
  云服务 7、银行 3、其他 2、话费 1；空投玩法：积分 25、领取 18、推荐 9、钱包连接 5、
  挂机节点 5、测试网 5、铸造 5、插件 3、水龙头 2。
- FDV 三参数（fdv_usd / pool_ratio / active_addresses）157 条全为空，卡片显示“待定”，属实。
- 时间戳字段均为 Unix 毫秒整数；`tags` / `play_types` 为 JSON 数组。
- `only_001` 推送偏好开关目前只保存、不参与推送过滤（语义未定，避免误删推送），定好含义后再接。

## 安全提醒

- 只监听局域网地址，不要暴露公网；推送设置没有管理员口令门，内网 + 不暴露就是保护。
- 推送渠道凭据与代理密码在库内明文存储，数据库文件不要发公开渠道、不要进公开仓库、不要发群里。
- 真实空投从不收费、不索要助记词、不收“激活费/税金/押金”；凡是让先转账、先付费、下载陌生 App、
  垫资刷单的，一律不收。
