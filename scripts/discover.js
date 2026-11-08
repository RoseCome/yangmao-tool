// 发现脚本 · 占位实现
// 本脚本为占位实现：自动发现需要人工/外部搜索核对后调用 saveDiscoveredDeals 入库；
// 此处不编造条目，不往库里写任何假条目。
// 职责：把 discovery_runs 最新一轮（或 DISCOVERY_RUN_ID 指定的一轮）状态更新为 done（added 0, skipped 0），退出码 0。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/app.db');
const runId = process.env.DISCOVERY_RUN_ID ? Number(process.env.DISCOVERY_RUN_ID) : null;

console.log('本脚本为占位实现：自动发现需要人工/外部搜索核对后调用 saveDiscoveredDeals 入库；此处不编造条目。');

const db = new DatabaseSync(DB_PATH);
const now = Date.now();
let row = null;
if (runId) {
  row = db.prepare(`SELECT * FROM discovery_runs WHERE id = ?`).get(runId);
} else {
  row = db.prepare(`SELECT * FROM discovery_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get();
}
if (row) {
  db.prepare(`UPDATE discovery_runs SET status = 'done', finished_at = ?, added = 0, skipped = 0,
    note = '占位实现：未自动入库任何条目，需人工核对后调用 saveDiscoveredDeals' WHERE id = ?`).run(now, row.id);
  console.log(`discovery run ${row.id} 已标记为 done（added 0, skipped 0）。`);
} else {
  console.log('没有正在运行的发现轮次，无需更新。');
}
process.exit(0);
