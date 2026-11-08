# 全网羊毛 · 每 6 小时自动发现

- **调度**：每 6 小时跑一次（0:00 / 6:00 / 12:00 / 18:00）。
- **做什么**：调用本地接口 `POST /api/discoverNow`，触发一次发现轮次（写入 `discovery_runs`，异步跑 `scripts/discover.js`）；发现到的候选条目经人工/外部搜索核对后，再调用 `POST /api/saveDiscoveredDeals` 入库。
- **调用**：`curl -X POST http://127.0.0.1:3000/api/discoverNow -H 'Content-Type: application/json' -d '{}'`

## 收录标准（发现时必须遵守）

- 只收**免费 / 白嫖**，不收购物优惠、付费折扣。
- **空投是重点**（能赚钱），其他羊毛只是娱乐。
- **收益估算只用 FDV 模型**：单号预估 = FDV × 空投总池比例 ÷ 净活跃地址 × 权重（基础 1.0x / 深入 1.5x / 核心 2.5x）；FDV、池比例、净活跃地址缺任一参数时写**待定**，绝不编数字。
- **玩法标签共 9 类**：直接领取 claim、积分 points、测试网 testnet、挂机/节点 node、水龙头 faucet、连接钱包 wallet、装插件 extension、铸造/NFT mint、拉人头/推荐 referral。
- **来源以英文/国外为主**：Twitter/X、Telegram、Reddit、airdrops.io、CryptoRank 等；中文的少。
- **论坛来源**：LINUX DO、V2EX、NodeSeek、52pojie —— 内容可以取，**论坛链接不入库**（只存官方领取页链接）。
- **红线**：不提交注册、不填用户手机号/邮箱、不用接码号；没有官方领取页的条目不入库。
