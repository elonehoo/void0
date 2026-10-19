import {GitHub, repositoryName} from './integrations.js';
import {acquirePublisherLock,createPublisherApp, privateText, validatePublisherConfig, type PublisherConfig} from './publisher.js';
import {dataDirectory,env} from './config.js';

const required=(name:string)=>{const value=env(name);if(!value)throw new Error(`缺少 VOID0_${name}`);return value;};
const privateKey=privateText(required('SIGNING_KEY_FILE'));
const apiToken=privateText(required('PUBLISHER_TOKEN_FILE')).trim();
const githubTokenFile=env('PUBLISHER_GITHUB_TOKEN_FILE');
const githubToken=githubTokenFile?privateText(githubTokenFile).trim():undefined;
const configFile=env('PUBLISHER_CONFIG_FILE');
const configRepository=env('PUBLISHER_CONFIG_REPOSITORY');
if(Boolean(configFile)===Boolean(configRepository))throw new Error('必须且只能选择本地发布配置或独立 GitHub 配置仓库');
const config=async():Promise<PublisherConfig>=>{
  if(configFile)return validatePublisherConfig(JSON.parse(privateText(configFile)));
  const repository=repositoryName(configRepository!),ref=env('PUBLISHER_CONFIG_REF')??'main',path=env('PUBLISHER_CONFIG_PATH')??(process.env.VOID0_PUBLISHER_CONFIG_REPOSITORY!==undefined?'void0.json':'serverdesk.json');
  if(!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)||path.split('/').includes('..'))throw new Error('GitHub 配置路径无效');
  const result=await new GitHub(githubToken??'').api<{type:string;encoding:string;size:number;content:string}>(`/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
  if(result.type!=='file'||result.encoding!=='base64'||result.size>512*1024)throw new Error('GitHub 发布配置无效或过大');
  return validatePublisherConfig(JSON.parse(Buffer.from(result.content,'base64').toString('utf8')));
};
await config();
const directory=dataDirectory('publisher');
const unlock=await acquirePublisherLock(directory);
const {app}=await createPublisherApp({dataDirectory:directory,privateKey,apiToken,githubToken,config});
const host=env('HOST')??process.env.HOST??'127.0.0.1',port=Number(env('PORT')??process.env.PORT??4321);
await app.listen({host,port});
console.log(`void0 Publisher is running at http://${host}:${port}`);
const shutdown=async()=>{await app.close();unlock();process.exit(0);};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
