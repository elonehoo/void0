import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const path=resolve(process.argv[2]??'.void0-postgres.env');
writeFileSync(path,`VOID0_DB_ADMIN_PASSWORD=${randomBytes(32).toString('hex')}\nVOID0_DB_PASSWORD=${randomBytes(32).toString('hex')}\n`,{mode:0o600,flag:'wx'});
console.log('已生成独立的数据库管理员密码和应用密码：'+path);
console.log('启动：docker compose --env-file '+path+' -f compose.yaml -f compose.postgres.yaml up -d --build');
