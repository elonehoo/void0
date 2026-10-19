import {env} from '../server/config.js';
import { backupPostgreSQL } from '../server/postgres-backup.js';
const [dataDirectory, backupDirectory] = process.argv.slice(2);
const databaseUrl = env('DATABASE_URL');
if (!dataDirectory || !backupDirectory || !databaseUrl) { console.error('用法：VOID0_DATABASE_URL=… npm run backup:postgres -- <数据目录> <新的备份目录>'); process.exitCode = 1; }
else {
  try { await backupPostgreSQL({ dataDirectory, backupDirectory, databaseUrl }); console.log('PostgreSQL 和独立密钥文件备份完成。'); }
  catch (error) { console.error(error instanceof Error ? error.message : '备份失败'); process.exitCode = 1; }
}
