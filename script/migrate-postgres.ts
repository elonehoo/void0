import {env} from '../server/config.js';
import { migrateSQLiteToPostgreSQL } from '../server/storage-transfer.js';
const args = process.argv.slice(2);
function argument(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
const sourceDirectory = argument('--source-dir');
const targetDirectory = argument('--target-dir');
const databaseUrl = env('DATABASE_URL');
if (!sourceDirectory || !targetDirectory || !databaseUrl || !args.includes('--confirm-stopped')) {
  console.error('用法：VOID0_DATABASE_URL=… npm run migrate:postgres -- --source-dir <原数据目录> --target-dir <新数据目录> --confirm-stopped');
  console.error('请先停止原 void0 并备份；目标 PostgreSQL 必须为空。原 SQLite 和 master.key 将保留。');
  process.exitCode = 1;
} else {
  try {
    const result = await migrateSQLiteToPostgreSQL({ sourceDirectory, targetDirectory, databaseUrl, confirmStopped: true });
    console.log(JSON.stringify({ status: result.imported ? 'imported' : 'already-imported', counts: result.counts }));
  } catch (error) { console.error(error instanceof Error ? error.message : '迁移失败'); process.exitCode = 1; }
}
