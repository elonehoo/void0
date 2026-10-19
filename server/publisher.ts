import Fastify from 'fastify';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp} from 'node:fs/promises';
import {z} from 'zod';
import {GitHub, repositoryName} from './integrations.js';
import {SSHRemote} from './remote.js';
import {contentSha256, servicePolicyHash, signRelease} from './releases.js';
import type {DeployPlan, Server, Service, SignedRelease} from '../shared/types.js';

export interface PublishedService {
  service:Service; server:Server; repository:string; branch:string;
  imageRepository:string; dockerfile?:string; context?:string;
}
export interface PublisherConfig {version:1;keyId:string;services:PublishedService[]}
export interface PublisherState {sequences:Record<string,number>;requests:Record<string,SignedRelease>;builds:Record<string,string>}
export interface PublisherOptions {
  dataDirectory:string;privateKey:string;apiToken:string;githubToken?:string;
  config:()=>Promise<PublisherConfig>;
  build?:(service:PublishedService,commit:string)=>Promise<string>;
  commit?:(service:PublishedService)=>Promise<string>;
  now?:()=>number;
}
const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const imageRepository=/^[a-zA-Z0-9][a-zA-Z0-9.:-]*\/[a-zA-Z0-9][a-zA-Z0-9_./-]{0,400}$/;
const branch=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const relative=(v:string)=>v==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(v)&&!v.split('/').some(p=>p==='..'||p==='.'||p.startsWith('-'));
const serviceFields=new Set(['id','name','kind','serverId','target','image','repository','branch','dockerfile','context','containerPort','hostPort','environment','volumes','autoDeploy','lastCommit','createdAt','updatedAt']);
const serverFields=new Set(['id','name','host','port','username','group','notes','connectionMode','createdAt','updatedAt']);

export function privateText(path:string):string {
  const full=resolve(path);
  const info=lstatSync(full);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||info.mode&0o077)throw new Error('发布器私密文件必须属于运行用户且权限为 0600');
  return readFileSync(full,'utf8');
}
function writeState(path:string,value:PublisherState):void {
  const temporary=path+'.'+randomUUID();
  const fd=openSync(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);
  const directory=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
}
export function validatePublisherConfig(config:PublisherConfig):PublisherConfig {
  if(config.version!==1||!/^[A-Za-z0-9_-]{1,80}$/.test(config.keyId)||!Array.isArray(config.services)||!config.services.length||config.services.length>1000)throw new Error('发布配置无效');
  const seen=new Set<string>();
  for(const item of config.services) {
    const {service,server}=item;
    if(!service||!server||!id.safeParse(service.id).success||!id.safeParse(server.id).success||seen.has(service.id)||service.kind!=='image'||service.serverId!==server.id||server.connectionMode!=='agent')throw new Error('受保护发布仅支持已接入 void0 OS 的镜像服务');
    if(Object.keys(service).some(key=>!serviceFields.has(key))||Object.keys(server).some(key=>!serverFields.has(key)))throw new Error('发布配置包含不支持的字段；不能包含服务器登录凭据');
    seen.add(service.id);
    if(!service.target||Object.keys(service.target).length||service.environment&&Object.keys(service.environment).length)throw new Error('发布器不能接收后台部署目标或应用密钥');
    if(!branch.test(item.branch)||item.branch.includes('..')||item.branch.includes('//')||item.branch.endsWith('/')||item.branch.endsWith('.lock'))throw new Error('发布分支无效');
    if(repositoryName(item.repository)!==item.repository||!imageRepository.test(item.imageRepository)||item.imageRepository.includes('..')||!relative(item.dockerfile??'Dockerfile')||!relative(item.context??'.'))throw new Error('发布仓库、构建路径或镜像仓库无效');
    if(!service.repository||!new RegExp('^(?:https://github\\.com/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$').test(service.repository)||service.repository.endsWith('.git')||repositoryName(service.repository)!==item.repository||service.branch!==item.branch)throw new Error('服务来源必须与发布器的仓库和分支一致');
    servicePolicyHash(service); // Validate the exact cross-language JSON representation before building.
  }
  return config;
}

/** Only this independently configured process can choose source, build arguments and sign a release. */
export class Publisher {
  private state:PublisherState;
  private queue:Promise<unknown>=Promise.resolve();
  private readonly now:()=>number;
  private readonly statePath:string;
  constructor(readonly options:PublisherOptions) {
    if(options.apiToken.length<32)throw new Error('发布器访问凭据至少需要 32 个字符');
    const root=resolve(options.dataDirectory);
    mkdirSync(root,{mode:0o700,recursive:true});
    const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.())throw new Error('发布器数据目录无效');
    chmodSync(root,0o700);
    this.statePath=join(root,'releases.json');
    this.state=existsSync(this.statePath)?JSON.parse(privateText(this.statePath)):{sequences:{},requests:{},builds:{}};
    if(!this.state.sequences||!this.state.requests||!this.state.builds)throw new Error('发布器状态无效');
    this.now=options.now??(()=>Math.floor(Date.now()/1000));
  }
  private async service(serviceId:string):Promise<{config:PublisherConfig;entry:PublishedService}> {
    const config=validatePublisherConfig(await this.options.config());
    const entry=config.services.find(item=>item.service.id===serviceId);
    if(!entry)throw new Error('此服务尚未在独立发布器授权');
    return {config,entry};
  }
  async catalog():Promise<Array<{service:Service;server:Server}>> {
    const config=validatePublisherConfig(await this.options.config());
    return config.services.map(entry=>({service:structuredClone(entry.service),server:structuredClone(entry.server)}));
  }
  async revision(serviceId:string):Promise<string> {
    const {entry}=await this.service(serviceId);
    return this.resolveCommit(entry);
  }
  private async resolveCommit(entry:PublishedService):Promise<string> {
    const commit=await (this.options.commit?.(entry)??new GitHub(this.options.githubToken??'').commit(entry.repository,entry.branch));
    if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('代码版本无效');
    return commit;
  }
  publish(serviceId:string,jobId:string):Promise<SignedRelease> {
    id.parse(serviceId);id.parse(jobId);
    const operation=this.queue.then(()=>this.publishOnce(serviceId,jobId));
    this.queue=operation.catch(()=>{});
    return operation;
  }
  private async publishOnce(serviceId:string,jobId:string):Promise<SignedRelease> {
    const existing=this.state.requests[jobId];
    if(existing) {
      if(existing.payload.plan.service.id!==serviceId)throw new Error('任务已绑定其他服务');
      return structuredClone(existing);
    }
    const {config,entry}=await this.service(serviceId);
    const commit=await this.resolveCommit(entry);
    // A changed trusted configuration gets a different build cache identity.
    const cacheKey=contentSha256({entry,commit});
    let image=this.state.builds[cacheKey];
    if(!image) image=await (this.options.build?.(entry,commit)??buildGitHubImage(entry,commit,this.options.githubToken));
    if(!new RegExp('^'+entry.imageRepository.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'@sha256:[a-f0-9]{64}$').test(image))throw new Error('构建结果必须是获准仓库中的不可变镜像');
    const sequence=(this.state.sequences[serviceId]??0)+1;
    if(!Number.isSafeInteger(sequence))throw new Error('发布序号已超过安全范围');
    const seconds=this.now(),date=new Date(seconds*1000).toISOString();
    const service={...structuredClone(entry.service),image,lastCommit:commit};
    const plan:DeployPlan={service,server:structuredClone(entry.server),job:{id:jobId,serviceId,serverId:entry.server.id,type:'deploy',source:'manual',state:'queued',stage:'等待发布',revision:commit,log:'',createdAt:date,updatedAt:date}};
    const release=signRelease({plan},{version:1,keyId:config.keyId,releaseId:randomUUID(),sequence,issuedAt:seconds,expiresAt:seconds+900,serverId:entry.server.id,serviceId,repository:entry.repository,branch:entry.branch,commit},this.options.privateKey);
    this.state={sequences:{...this.state.sequences,[serviceId]:sequence},requests:{...this.state.requests,[jobId]:release},builds:{...this.state.builds,[cacheKey]:image}};
    writeState(this.statePath,this.state);
    return structuredClone(release);
  }
}

const execute=promisify(execFile);
const EXTRACT=String.raw`import os, pathlib, sys, tarfile
root=pathlib.Path(sys.argv[2]).resolve();size=0;count=0
with tarfile.open(sys.argv[1],'r:gz') as archive:
 for member in archive:
  count+=1;size+=member.size
  parts=pathlib.PurePosixPath(member.name).parts
  if count>50000 or size>256*1024*1024 or not parts or parts[0] in ('.','..','/') or '..' in parts or not (member.isdir() or member.isfile()):raise ValueError('Unsafe source archive')
  target=root.joinpath(*parts[1:])
  if not target.is_relative_to(root):raise ValueError('Source archive escaped build directory')
  if member.isdir():target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True)
   with archive.extractfile(member) as source,open(target,'xb') as output:output.write(source.read())
   target.chmod(0o700 if member.mode & 0o111 else 0o600)
`;
export async function buildGitHubImage(entry:PublishedService,commit:string,githubToken?:string):Promise<string> {
  const directory=await mkdtemp(join(tmpdir(),'serverdesk-build-'));
  try {
    const [owner,repo]=entry.repository.split('/');
    const archive=await new SSHRemote({dataDir:directory}).repositoryArchive({owner,repo,commit,token:githubToken});
    const archivePath=join(directory,'source.tar.gz'),sourcePath=join(directory,'source');
    mkdirSync(sourcePath,{mode:0o700});writeFileSync(archivePath,archive,{mode:0o600});
    const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT,DOCKER_CONFIG:process.env.DOCKER_CONFIG};
    await execute('python3',['-c',EXTRACT,archivePath,sourcePath],{timeout:60_000,maxBuffer:1024*1024,env});
    const tag=entry.imageRepository+':sd-'+commit+'-'+randomUUID().slice(0,8);
    await execute('docker',['build','--label','org.opencontainers.image.revision='+commit,'-f',join(sourcePath,entry.dockerfile??'Dockerfile'),'-t',tag,join(sourcePath,entry.context??'.')],{timeout:30*60_000,maxBuffer:8*1024*1024,env});
    await execute('docker',['push',tag],{timeout:15*60_000,maxBuffer:4*1024*1024,env});
    const inspected=await execute('docker',['image','inspect','--format','{{json .RepoDigests}}',tag],{timeout:30_000,env});
    const digest=(JSON.parse(inspected.stdout) as string[]).find(value=>value.startsWith(entry.imageRepository+'@sha256:'));
    if(!digest)throw new Error('镜像推送后未返回内容摘要');
    return digest;
  } finally {rmSync(directory,{recursive:true,force:true});}
}

export async function createPublisherApp(options:PublisherOptions) {
  const publisher=new Publisher(options),app=Fastify({logger:false,bodyLimit:4096});
  app.addHook('onRequest',async(req,reply)=>{
    if(req.url==='/healthz')return;
    const supplied=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(options.apiToken);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply.code(401).send({error:'发布器身份验证失败'});
  });
  app.setErrorHandler((_error,_req,reply)=>reply.code(400).send({error:'发布未完成，请检查独立发布器的配置、源码与镜像仓库'}));
  app.get('/healthz',async()=>({ok:true}));
  app.get('/v1/catalog',async()=>({services:await publisher.catalog()}));
  app.get('/v1/services/:id/revision',async req=>({commit:await publisher.revision(id.parse((req.params as {id:string}).id))}));
  app.post('/v1/releases',async req=>{const input=z.object({serviceId:id,jobId:id}).strict().parse(req.body);return publisher.publish(input.serviceId,input.jobId);});
  return {app,publisher};
}

export class PublisherClient {
  private readonly url:string;
  constructor(url:string,private readonly token:string,private readonly request:typeof fetch=fetch) {
    const parsed=new URL(url);
    if((parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1'))||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')throw new Error('独立发布器地址必须为 HTTPS origin');
    this.url=parsed.origin;
  }
  private async call<T>(path:string,body?:unknown):Promise<T> {
    const response=await this.request(this.url+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(body?45*60_000:30_000),headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok)throw Object.assign(new Error('独立发布器尚未完成授权或构建，请检查发布器'),{outcomeKnown:true});
    const raw=await response.text();if(Buffer.byteLength(raw)>1024*1024)throw new Error('独立发布器返回内容过大');
    return JSON.parse(raw) as T;
  }
  async revision(serviceId:string):Promise<string>{const result=await this.call<{commit:string}>('/v1/services/'+encodeURIComponent(id.parse(serviceId))+'/revision');if(!/^[a-f0-9]{40}$/.test(result.commit))throw new Error('发布器代码版本无效');return result.commit;}
  publish(serviceId:string,jobId:string):Promise<SignedRelease>{return this.call('/v1/releases',{serviceId:id.parse(serviceId),jobId:id.parse(jobId)});}
  async catalog():Promise<Array<{service:Service;server:Server}>>{const result=await this.call<{services:Array<{service:Service;server:Server}>}>('/v1/catalog');if(!Array.isArray(result.services))throw new Error('发布器服务目录无效');return result.services;}
}

/** Kernel-held lock: releasing or killing the process releases the lock, without stale lock recovery. */
export async function acquirePublisherLock(dataDirectory:string):Promise<()=>void> {
  mkdirSync(dataDirectory,{recursive:true,mode:0o700});
  const processLock=spawn('flock',['--no-fork','--nonblock',join(resolve(dataDirectory),'publisher.lock'),'sh','-c','printf "locked\\n"; cat >/dev/null'],{stdio:['pipe','pipe','pipe']});
  await new Promise<void>((accept,reject)=>{
    const timer=setTimeout(()=>{processLock.kill();reject(new Error('发布器无法取得独占锁'));},10_000);
    processLock.once('error',()=>{clearTimeout(timer);reject(new Error('发布器需要 Linux flock，以保证发布序号不被并发进程覆盖'));});
    processLock.once('exit',()=>{clearTimeout(timer);reject(new Error('此数据目录已经被另一个发布器使用'));});
    processLock.stdout.once('data',()=>{clearTimeout(timer);accept();});
  });
  let released=false;
  processLock.once('exit',()=>{if(!released)process.kill(process.pid,'SIGTERM');});
  return ()=>{released=true;processLock.stdin.end();};
}
