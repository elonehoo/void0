import { backupSQLite } from '../server/storage-transfer.js';
const [sourceDirectory, backupDirectory] = process.argv.slice(2);
if (!sourceDirectory || !backupDirectory) { console.error('用法：npm run backup:sqlite -- <数据目录> <新的备份目录>'); process.exitCode = 1; }
else {
  try { await backupSQLite(sourceDirectory, backupDirectory); console.log('SQLite 和独立密钥文件备份完成。'); }
  catch (error) { console.error(error instanceof Error ? error.message : '备份失败'); process.exitCode = 1; }
}
