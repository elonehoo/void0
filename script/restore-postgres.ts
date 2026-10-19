import {env} from '../server/config.js';
import { restorePostgreSQL } from '../server/postgres-backup.js';
const [backupDirectory, dataDirectory, confirmation] = process.argv.slice(2);
const databaseUrl = env('DATABASE_URL');
if (!dataDirectory || !backupDirectory || !databaseUrl || confirmation !== '--confirm-stopped') { console.error('用法：VOID0_DATABASE_URL=… npm run restore:postgres -- <备份目录> <新的数据目录> --confirm-stopped'); console.error('恢复前必须停止目标 void0，PostgreSQL 目标必须为空。'); process.exitCode = 1; }
else {
  try { await restorePostgreSQL({ dataDirectory, backupDirectory, databaseUrl, confirmStopped: true }); console.log('PostgreSQL 和独立密钥文件恢复完成。'); }
  catch (error) { console.error(error instanceof Error ? error.message : '恢复失败'); process.exitCode = 1; }
}
