import type {FastifyInstance} from 'fastify';
import {resolve4,resolve6} from 'node:dns/promises';
import {isIP} from 'node:net';
import {connect} from 'node:tls';
import {domainToASCII} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {DomainBinding,DomainOperation,DomainRecord,DockerDomainState,RemoteTransport,Server,Service,ServiceDomains,SSHCredential} from '../shared/types.js';
import {Store} from './store.js';
import {Vercel,type VercelDomain} from './integrations.js';

const ids=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const key=(id:string)=>`domains:service:${id}`;
interface Intent { names:string[]; managedNames?:string[]; pending?:{action:'add'|'remove';name:string;at:string} }
export function normalizeDomain(input:string):string {
  if(typeof input!=='string'||input.length>253||input!==input.trim()||/[\s/@:*\\?#]/.test(input))throw new Error('请填写完整域名，不包含协议、端口或路径。');
  const value=domainToASCII(input.toLowerCase());
  if(!value||value.length>253||isIP(value)||!value.includes('.')||value.split('.').some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(value))throw new Error('请填写有效的公网域名，暂不支持通配符。');
  return value;
}
export async function assertDomainTargetUnchanged(store:Store,previous:Service,next:Service):Promise<void> {
  const intent=await store.getSetting<Intent>(key(previous.id));
  if(!intent?.names.length&&!intent?.pending)return;
  if(!isDeepStrictEqual([previous.kind,previous.serverId,previous.target,previous.containerPort,previous.hostPort],[next.kind,next.serverId,next.target,next.containerPort,next.hostPort]))throw new Error('此服务仍绑定域名，请先移除域名，再修改服务器、部署目标或端口。');
}
export async function assertServiceHasNoDomains(store:Store,service:Service|string):Promise<void> {
  const intent=await store.getSetting<Intent>(key(typeof service==='string'?service:service.id));
  if(intent?.names.length||intent?.pending)throw new Error('此服务仍绑定域名或有结果待确认，请先移除域名。');
}
export async function assertServiceDomainsRemoved(store:Store,serviceId:string):Promise<void> {
  const intent=await store.getSetting<Intent>(key(serviceId));
  if(intent?.managedNames?.length||intent?.pending)throw new Error('此服务仍有 void0 配置的域名或结果待确认，请先移除域名。');
}
async function addresses(name:string):Promise<string[]> {
  if(isIP(name))return [name];
  const rows=await Promise.allSettled([resolve4(name),resolve6(name)]);
  return rows.flatMap(row=>row.status==='fulfilled'?row.value:[]);
}
async function batches<T,R>(rows:T[],fn:(row:T)=>Promise<R>):Promise<R[]> {
  const output:R[]=[];for(let i=0;i<rows.length;i+=4)output.push(...await Promise.all(rows.slice(i,i+4).map(fn)));return output;
}
async function validTLS(name:string,ips:string[]):Promise<boolean> {
  // DNS is resolved once, and the socket is pinned to those addresses. Never follow redirects.
  for(const ip of ips.slice(0,3)) {
    if(!isIP(ip))continue;
    const success=await new Promise<boolean>(resolve=>{
      let settled=false;const done=(value:boolean)=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
      const socket=connect({host:ip,port:443,servername:name,rejectUnauthorized:true},()=>done(socket.authorized));
      socket.setTimeout(2500,()=>done(false));socket.once('error',()=>done(false));
    });
    if(success)return true;
  }
  return false;
}
const privateAddress=(ip:string)=>isIP(ip)===4?/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip):/^(?:::|fc|fd|fe[89ab])/i.test(ip);
export function dockerDomainState(value:unknown):DockerDomainState {
  const parsed=z.object({domains:z.array(z.object({name:z.string().transform(normalizeDomain),hostPort:z.number().int().min(1).max(65535)}).strict()).max(500),proxyReady:z.boolean(),upstreamReady:z.boolean().optional()}).strict().parse(value);
  if(new Set(parsed.domains.map(row=>row.name)).size!==parsed.domains.length)throw new Error('服务器返回了重复域名。');return parsed;
}
interface Dependencies {store:Store;remote:RemoteTransport;dns?:(name:string)=>Promise<string[]>;tls?:(name:string,ips:string[])=>Promise<boolean>;vercel?:(token:string,teamId?:string)=>Vercel}
export function registerDomainRoutes(app:FastifyInstance,{store,remote,dns=addresses,tls=validTLS,vercel=(token,teamId)=>new Vercel(token,fetch,teamId)}:Dependencies):void {
  const locks=new Map<string,Promise<unknown>>();
  const exclusive=async<T>(id:string,fn:()=>Promise<T>):Promise<T>=>{
    const previous=locks.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(id,next);
    try{return await next;}finally{if(locks.get(id)===next)locks.delete(id);}
  };
  const required=async(id:string)=>{ids.parse(id);const service=await store.getService(id);if(!service)throw new Error('服务不存在。');if(!(await store.allProjects()).some(project=>project.serviceIds.includes(id)))throw new Error('请先将此服务归入项目，再管理域名。');return service;};
  const provider=async()=>{const credential=await store.vault.get<{token:string;teamId?:string;userId?:string;authorization?:string}>('vercel');if(!credential)throw new Error('请在设置中连接 Vercel。');return vercel(credential.token,credential.authorization==='vercel-integration'?(credential.teamId??credential.userId):credential.teamId);};
  const operation=(service:Service,action:DomainOperation['action'],name?:string):DomainOperation=>({action,service:{id:service.id,kind:service.kind,target:service.target,...(service.hostPort?{hostPort:service.hostPort}:{}),...(service.containerPort?{containerPort:service.containerPort}:{})},...(name?{name}:{})});
  const node=async(service:Service):Promise<Server>=>{
    if(!['source','image','compose','container'].includes(service.kind)||!service.serverId)throw new Error('域名只支持 Docker HTTP 服务和 Vercel，当前服务类型暂不支持。');
    const server=await store.getServer(service.serverId);if(!server)throw new Error('目标服务器不存在。');
    if(!remote.domain)throw new Error('当前连接尚未支持域名管理，请更新 void0 OS。');
    if(remote.canControl&&!(await remote.canControl(server)))throw new Error('服务器尚未连接，无法确认域名状态。');
    return server;
  };
  const docker=async(service:Service,action:DomainOperation['action'],name?:string)=>{
    const server=await node(service);const credential=await store.vault.get<SSHCredential>(`ssh:${server.id}`);
    return dockerDomainState(await remote.domain!(server,credential,operation(service,action,name)));
  };
  const intended=async(id:string)=>await store.getSetting<Intent>(key(id))??{names:[]};
  const recordActual=async(service:Service,names:string[])=>{
    const previous=await intended(service.id);
    const managed=service.kind==='vercel'?(previous.managedNames??[]).filter(name=>names.includes(name)):names;
    if(previous.pending?.action==='add'&&names.includes(previous.pending.name)&&!managed.includes(previous.pending.name))managed.push(previous.pending.name);
    const pending=previous.pending&&!((previous.pending.action==='add'&&names.includes(previous.pending.name))||(previous.pending.action==='remove'&&!names.includes(previous.pending.name)))?previous.pending:undefined;
    await store.setSetting<Intent>(key(service.id),{names,managedNames:managed,...(pending?{pending}:{})});
  };
  const dockerRows=async(service:Service,state:DockerDomainState):Promise<DomainBinding[]>=>{
    const server=await node(service),expected=await dns(server.host),checkedAt=new Date().toISOString();
    const records:DomainRecord[]=isIP(server.host)?[{type:isIP(server.host)===6?'AAAA':'A',name:'',value:server.host}]:[{type:'CNAME',name:'',value:server.host}];
    return await batches(state.domains,async row=>{
      const ips=await dns(row.name),matching=ips.filter(ip=>expected.includes(ip));
      const status:DomainBinding['status']=!matching.length?'pending_dns':!state.proxyReady||state.upstreamReady===false?'error':await tls(row.name,matching)?'ready':'pending_https';
      return {name:row.name,provider:'docker',status,message:status==='ready'?'域名和 HTTPS 已就绪。':status==='pending_dns'?'等待 DNS 指向此服务器；修改解析后重新检查。':status==='error'?'反向代理或服务端口尚未就绪，请检查服务器。':'代理已配置，等待 HTTPS 证书签发；请确认公网 80 和 443 端口可访问。',records:records.map(record=>({...record,name:row.name})),checkedAt};
    });
  };
  const vercelRow=async(client:Vercel,service:Service,row:VercelDomain):Promise<DomainBinding>=>{
    const checkedAt=new Date().toISOString(),records:DomainRecord[]=[];
    for(const entry of row.verification??[])if(['A','AAAA','CNAME','TXT'].includes(entry.type)&&typeof entry.domain==='string'&&typeof entry.value==='string')records.push({type:entry.type as DomainRecord['type'],name:entry.domain,value:entry.value});
    try {
      const config=await client.domainConfig(service,row.name);
      const cname=(config.recommendedCNAME??[]).slice().sort((a,b)=>a.rank-b.rank)[0];
      if(cname?.value)records.push({type:'CNAME',name:row.name,value:cname.value});
      else for(const value of (config.recommendedIPv4??[]).slice().sort((a,b)=>a.rank-b.rank)[0]?.value??[])records.push({type:'A',name:row.name,value});
      let status:DomainBinding['status']='pending_dns';
      if(row.verified===true&&config.misconfigured===false) {
        const ips=(await dns(row.name)).filter(ip=>!privateAddress(ip));status=await tls(row.name,ips)?'ready':'pending_https';
      }
      return {name:row.name,provider:'vercel',status,message:status==='ready'?'Vercel 域名和 HTTPS 已就绪。':status==='pending_https'?'Vercel 已确认解析，等待 HTTPS 证书就绪。':row.verified?'请按下方记录修改 DNS，然后重新检查。':'请完成下方 TXT 所有权验证及 DNS 解析，然后重新检查。',records,checkedAt};
    }catch{return {name:row.name,provider:'vercel',status:row.verified===false&&records.length?'pending_dns':'error',message:row.verified===false&&records.length?'请完成下方 TXT 所有权验证，再重新检查 DNS 配置。':'Vercel 暂时无法确认此域名的解析，请检查连接权限后重新检查。',records,checkedAt};}
  };
  const read=async(service:Service,focus?:string):Promise<ServiceDomains>=>{
    if(service.kind==='vercel') {
      const client=await provider(),rows=await client.projectDomains(service);await recordActual(service,rows.map(row=>row.name));
      const checked=new Set([...(focus?[focus]:[]),...rows.slice(0,20).map(row=>row.name)]);
      return {serviceId:service.id,supported:true,domains:await batches(rows,async row=>checked.has(row.name)?vercelRow(client,service,row):({name:row.name,provider:'vercel',status:'error',message:'域名较多，请点击重新检查以单独核验此域名。',records:[],checkedAt:new Date().toISOString()}))};
    }
    if(!['source','image','compose','container'].includes(service.kind))return {serviceId:service.id,supported:false,reason:'当前只支持 Docker HTTP 服务和 Vercel。',domains:[]};
    try {const state=await docker(service,'list');await recordActual(service,state.domains.map(row=>row.name));return {serviceId:service.id,supported:true,domains:await dockerRows(service,state)};}
    catch(error){const intent=await intended(service.id),message=error instanceof Error?error.message:'服务器暂时无法确认域名状态。';return {serviceId:service.id,supported:false,reason:message,domains:[...new Set([...intent.names,...(intent.pending?[intent.pending.name]:[])])].map(name=>({name,provider:'docker',status:'error',message,records:[],checkedAt:new Date().toISOString()}))};}
  };
  const mutate=async(service:Service,action:'add'|'remove',name:string):Promise<ServiceDomains>=>exclusive(service.serverId??service.id,async()=>{
    if((await store.allJobs()).some(job=>job.serverId===service.serverId&&['queued','running','unknown'].includes(job.state)))throw new Error('此服务器仍有任务正在运行或结果待确认，请结束后修改域名。');
    const current=await read(service);if(!current.supported)throw new Error(current.reason);
    if((await intended(service.id)).pending)throw new Error('上次域名操作的结果仍待确认；不会自动重发，请检查服务器后重新检查。');
    const exists=current.domains.some(row=>row.name===name);
    if(action==='add'&&exists)return current;
    if(action==='add'&&current.domains.length>=25)throw new Error('每个服务最多通过 void0 绑定 25 个域名。');
    if(action==='remove'&&!exists)throw new Error('此域名未绑定到所选服务。');
    if(action==='add')for(const item of await store.allServices())if(item.id!==service.id&&(await intended(item.id)).names.includes(name))throw new Error('此域名已绑定到其他服务，请先解除原绑定。');
    if(service.kind==='vercel'&&name.endsWith('.vercel.app'))throw new Error('Vercel 自动生成的域名由 Vercel 管理，请添加自定义域名。');
    const before=await intended(service.id);await store.setSetting<Intent>(key(service.id),{...before,pending:{action,name,at:new Date().toISOString()}});
    try {
      if(service.kind==='vercel') {const client=await provider();if(action==='add')await client.addDomain(service,name);else await client.removeDomain(service,name);}
      else await docker(service,action,name);
      // A separate read confirms the remote configuration. No mutation is retried on failure.
      const result=await read(service,name);
      if(!result.supported||(action==='add')!==result.domains.some(row=>row.name===name))throw new Error('远端更改已提交，但尚未确认域名配置结果。');
      return result;
    } catch(error) {
      if(error instanceof Error&&'outcomeKnown' in error&&error.outcomeKnown===true)await store.setSetting(key(service.id),before);
      const message=error instanceof Error?error.message:'请求中断';throw new Error(`${message}；不会自动重试，请重新检查远端状态。`);
    }
  });
  app.get<{Params:{id:string}}>('/api/services/:id/domains',async req=>{const service=await required(req.params.id);return exclusive(service.serverId??service.id,()=>read(service));});
  app.post<{Params:{id:string}}>('/api/services/:id/domains',async req=>{const {name}=z.object({name:z.string()}).strict().parse(req.body);return mutate(await required(req.params.id),'add',normalizeDomain(name));});
  app.delete<{Params:{id:string;domain:string}}>('/api/services/:id/domains/:domain',async req=>mutate(await required(req.params.id),'remove',normalizeDomain(req.params.domain)));
  app.post<{Params:{id:string;domain:string}}>('/api/services/:id/domains/:domain/verify',async req=>{
    const service=await required(req.params.id),name=normalizeDomain(req.params.domain);
    return exclusive(service.serverId??service.id,async()=>{
      const current=await read(service,name);if(!current.domains.some(row=>row.name===name))throw new Error('此域名未绑定到所选服务。');
      if(service.kind==='vercel'){const client=await provider();const row=(await client.projectDomains(service)).find(row=>row.name===name);if(row?.verified===false)await client.verifyDomain(service,name);}
      return read(service,name);
    });
  });
}
