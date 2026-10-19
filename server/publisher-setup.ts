import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {privateText,validatePublisherConfig,type PublisherConfig} from './publisher.js';
import {servicePolicyHash} from './releases.js';

const [command,input,output,publicKeyPath]=process.argv.slice(2);
if(command==='init'&&input) {
  const root=resolve(input);mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
  if(['publisher.key','publisher.pub','api-token'].some(name=>existsSync(join(root,name))))throw new Error('目录中已有密钥或凭据，拒绝覆盖');
  const pair=generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  writeFileSync(join(root,'publisher.key'),pair.privateKey,{mode:0o600,flag:'wx'});
  writeFileSync(join(root,'publisher.pub'),pair.publicKey,{mode:0o644,flag:'wx'});
  writeFileSync(join(root,'api-token'),randomBytes(32).toString('base64url')+'\n',{mode:0o600,flag:'wx'});
  console.log('已生成发布密钥、公钥和请求凭据；只把公钥复制到业务服务器。');
} else if(command==='policies'&&input&&output&&publicKeyPath) {
  const config=validatePublisherConfig(JSON.parse(privateText(input)) as PublisherConfig),root=resolve(output);
  mkdirSync(root,{recursive:true,mode:0o700});
  const policies=new Map<string,{version:1;mode:'strict';serverId:string;maxReleaseLifetimeSeconds:number;keys:Record<string,string>;services:Record<string,unknown>}>();
  for(const entry of config.services) {
    const policy=policies.get(entry.server.id)??{version:1,mode:'strict',serverId:entry.server.id,maxReleaseLifetimeSeconds:900,keys:{[config.keyId]:publicKeyPath},services:{}};
    policy.services[entry.service.id]={repository:entry.repository,branch:entry.branch,serviceSha256:servicePolicyHash(entry.service),imageRepositories:[entry.imageRepository]};
    policies.set(entry.server.id,policy);
  }
  for(const [serverId,policy] of policies){const path=join(root,serverId+'.json');writeFileSync(path,JSON.stringify(policy,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(path);}
} else {
  console.error('Usage: publisher-setup init DIRECTORY | policies CONFIG_JSON OUTPUT_DIRECTORY NODE_PUBLIC_KEY_PATH');process.exitCode=1;
}
