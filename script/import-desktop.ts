import { resolve } from 'node:path';
import {dataDirectory,env} from '../server/config.js';
import { importDesktop } from '../server/import-desktop.js';

const arguments_=process.argv.slice(2);
if (arguments_.includes('--help')) {
  console.log('用法：npm run import:desktop -- --workspace <项目数据库> --profiles <服务器数据库> [--destination <目标目录>]');
  process.exit(0);
}
const options=new Map<string,string>();
for (let index=0;index<arguments_.length;index+=2) {
  const name=arguments_[index]; const value=arguments_[index+1];
  if (!['--workspace','--profiles','--destination'].includes(name) || !value || value.startsWith('--')) throw new Error('导入参数无效；使用 --help 查看用法');
  options.set(name,value);
}
if(!options.has('--workspace')||!options.has('--profiles'))throw new Error('请显式指定 --workspace 和 --profiles；导入不会自动访问本机个人目录。');
try {
  const result=(await importDesktop({workspacePath:resolve(options.get('--workspace')!),profilesPath:resolve(options.get('--profiles')!),destination:resolve(options.get('--destination')??dataDirectory()),databaseUrl:env('DATABASE_URL')}));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  console.error(error instanceof Error?error.message:'导入失败'); process.exitCode=1;
}
