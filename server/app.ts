import {managedComposeTarget} from '../shared/service-target.js';
import Fastify, {type FastifyRequest, type FastifyReply} from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {Store} from './store.js';
import type {PublisherClient} from './publisher.js';
import {AgentController} from './agent-controller.js';
import {ManagedRemote} from './managed-remote.js';
import {agentBundle,agentInstaller,agentManifest} from './agent-bundle.js';
import {BOOTSTRAP_SCRIPT,DEFAULT_K3S_VERSION,k3sBootstrapScript} from './remote-scripts.js';
import {JobManager,activeJob,safeMessage} from './jobs.js';
import {GitHub,Vercel,repositoryName,validWebhook} from './integrations.js';
import {registerConnectionRoutes,type ConnectionStatus} from './connection-routes.js';
import {registerProviderOAuth,getProviderToken,type ProviderCredential} from './provider-oauth.js';
import {registerDomainRoutes,assertDomainTargetUnchanged,assertServiceDomainsRemoved} from './domains.js';
import type {Project,Server,Service,Job,RemoteTransport,ServerStatus,SSHCredential} from '../shared/types.js';

declare module 'fastify' { interface FastifyRequest { rawBody:Buffer; sessionId?:string; session?:Session; agentServerId?:string } }
interface Session { csrf:string; expires:number }
export interface AppOptions { dataDir:string; remote?:RemoteTransport; startWorker?:boolean; webRoot?:string; publicUrl?:string; setupToken?:string; databaseUrl?:string; publisher?:Pick<PublisherClient,'revision'|'publish'|'catalog'> }
const idSchema=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const nameSchema=z.string().trim().min(1).max(80).refine(v=>!/[\x00-\x1f]/.test(v));
const portSchema=z.number().int().min(1).max(65535);
const relativePath=z.string().max(256).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/).refine(v=>!v.split('/').some(p=>p==='..'||p==='.'||p.startsWith('-')));
const branchSchema=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(v=>!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.lock')&&!v.split('/').some(p=>p.startsWith('.')));
const serverSchema=z.object({name:nameSchema,host:z.string().min(1).max(255).regex(/^[A-Za-z0-9[\]:_.-]+$/).refine(v=>!v.startsWith('-')),port:portSchema.default(22),username:z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).default('ubuntu'),group:z.string().max(80).default('默认'),notes:z.string().max(2000).default(''),connectionMode:z.enum(['ssh','agent']).optional()});
const projectSchema=z.object({name:nameSchema,description:z.string().max(1000).default(''),serviceIds:z.array(idSchema).max(1000).optional()});
const serviceSchema=z.object({projectId:idSchema.optional(),name:nameSchema,kind:z.enum(['source','image','compose','kubernetes','container','vercel']).optional(),serverId:idSchema.optional(),repository:z.string().max(256).optional(),branch:branchSchema.optional(),dockerfile:relativePath.optional(),context:z.union([z.literal('.'),relativePath]).optional(),image:z.string().max(512).regex(/^[A-Za-z0-9][A-Za-z0-9/_.:@-]*$/).optional(),containerPort:portSchema.optional(),hostPort:portSchema.optional(),environment:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),z.string().max(16384)).optional(),volumes:z.array(z.object({name:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/),mountPath:z.string().max(512).regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\/?$/).refine(p=>!p.split('/').some(s=>s==='.'||s==='..'))})).max(20).optional(),autoDeploy:z.boolean().optional()});

export async function createApp(options:AppOptions) {
  const app=Fastify({logger:false,bodyLimit:1_048_576,trustProxy:false});
  const store=new Store(options.dataDir,{databaseUrl:options.databaseUrl});
  try {await store.ready();}catch(error){await store.close().catch(()=>{});throw error;}
  if(options.publisher && await store.vault.has('github')){
    await store.close();
    throw new Error('独立发布器模式不允许管理后台保存 GitHub Token；请先在兼容模式断开 GitHub 连接后重启，已有凭据未被删除。');
  }
  if(options.publisher && await store.vault.hasPrefix('ssh:')){
    await store.close();
    throw new Error('独立发布器模式不允许管理后台保存 SSH 密码或私钥；请先在兼容模式删除 SSH 登录凭据后重启，已有凭据未被删除。');
  }
  if(options.publisher){
    for(const service of await store.allServices()){
      if(Object.keys(await store.getServiceEnvironment(service.id)).length){
        await store.close();
        throw new Error('独立发布器模式不允许管理后台保存应用环境变量；请先在兼容模式把变量移至业务服务器本地文件，清除后台变量并撤销或轮换旧凭据；已有资料未被删除。');
      }
    }
  }
  const agents=new AgentController(store);
  try {await agents.ready();}catch(error){await store.close().catch(()=>{});throw error;}
  const remote=options.remote??new ManagedRemote(store,agents);
  const jobs=new JobManager(store,remote,options.publisher);
  const setupPath=join(options.dataDir,'setup-token');
  if(!existsSync(setupPath)) {writeFileSync(setupPath,randomBytes(24).toString('base64url'),{mode:0o600,flag:'wx'});}
  chmodSync(setupPath,0o600);
  const setupToken=options.setupToken??readFileSync(setupPath,'utf8').trim();
  if(options.publicUrl) (await store.setSetting('publicUrl',publicUrl(options.publicUrl)));
  const attempts=new Map<string,{count:number;at:number}>();
  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer'},(req,body,done)=>{
    req.rawBody=body as Buffer;
    try {done(null,JSON.parse((body as Buffer).toString('utf8')));} catch {done(new Error('请求内容不是有效 JSON。'));}
  });
  app.addHook('onRequest',async(req,reply)=>{
    const url=req.url.split('?')[0];
    const allowed=new Set(['localhost','127.0.0.1','[::1]']);
    const configured=(await store.getSetting<string>('publicUrl')); if(configured) allowed.add(new URL(configured).hostname);
    let host:string;try{host=new URL(`http://${req.headers.host??'localhost'}`).hostname;}catch{return reply.code(400).send({error:'访问地址无效。'});}
    if(!allowed.has(host)) return reply.code(403).send({error:'此域名尚未配置为管理平台地址。'});
    if(url.startsWith('/api/agent/')) {
      const publicPaths=['/api/agent/register','/api/agent/install.sh','/api/agent/manifest','/api/agent/bundle'];
      if(!publicPaths.includes(url)) {
        const authorization=req.headers.authorization;
        if(!authorization?.startsWith('Bearer '))return reply.code(401).send({error:'Agent 身份验证失败。'});
        try{req.agentServerId=(await agents.authenticate(authorization.slice(7)));}catch{return reply.code(401).send({error:'Agent 身份验证失败。'});}
      }
      return;
    }
    if(url.startsWith('/api/') && !url.startsWith('/api/hooks/')) {
      const origin=req.headers.origin;
      if(origin) {
        const validOrigins=new Set([`http://${req.headers.host}`,`https://${req.headers.host}`,'http://127.0.0.1:5173','http://localhost:5173']);
        if(configured) validOrigins.add(new URL(configured).origin);
        if(!validOrigins.has(origin)) return reply.code(403).send({error:'请求来源不被允许。'});
      }
      const token=req.cookies.serverdesk_session;
      if(token) {
        const sid=createHash('sha256').update(token).digest('hex');
        const session=(await store.vault.get<Session>(`session:${sid}`));
        if(session && session.expires>Date.now()) {req.session=session;req.sessionId=sid;}
      }
      const open=['/api/session','/api/login','/api/setup'].includes(url)||(req.method==='GET'&&/^\/api\/integrations\/(?:github|vercel)\/callback$/.test(url));
      if(!open && !req.session) return reply.code(401).send({error:'请登录管理平台。'});
      if(!open && !['GET','HEAD'].includes(req.method) && !secureEqual(req.headers['x-csrf-token'],req.session?.csrf)) return reply.code(403).send({error:'登录状态已变化，请刷新页面后重试。'});
    }
  });
  app.addHook('onSend',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(req.url.startsWith('/api/')) reply.header('Cache-Control','no-store');
  });
  app.setErrorHandler((error,req,reply)=>{
    const known=error instanceof Error?error:new Error('操作未完成。');
    if(error instanceof z.ZodError) return reply.code(400).send({error:'输入内容不完整或格式不正确：'+error.issues.map(i=>i.path.join('.')).slice(0,4).join('、')});
    const status=(error as {statusCode?:number}).statusCode;
    return reply.code(status===503?503:status && status>=400&&status<500?status:400).send({error:safeMessage(known)});
  });
  const session=async (req:FastifyRequest)=>({authenticated:!!req.session,setupRequired:!(await store.vault.has('admin')),setupTokenRequired:!(await store.vault.has('admin')),...(req.session?{csrfToken:req.session.csrf}:{})});
  const issueSession=async (reply:FastifyReply)=>{
    const token=randomBytes(32).toString('base64url'),sid=createHash('sha256').update(token).digest('hex');
    const value={csrf:randomBytes(24).toString('base64url'),expires:Date.now()+12*60*60*1000};
    (await store.vault.set(`session:${sid}`,value));
    reply.setCookie('serverdesk_session',token,{httpOnly:true,sameSite:'strict',secure:(await store.getSetting<string>('publicUrl'))?.startsWith('https://')??false,path:'/',maxAge:12*60*60});
    return {authenticated:true,setupRequired:false,setupTokenRequired:false,csrfToken:value.csrf};
  };
  const rateLimit=(req:FastifyRequest)=>{
    const key=req.ip,entry=attempts.get(key),now=Date.now();
    if(entry && now-entry.at<60_000) {if(entry.count>=5) throw new Error('尝试次数过多，请一分钟后重试。');entry.count++;}
    else attempts.set(key,{count:1,at:now});
    if(attempts.size>1000) for(const [k,v] of attempts) if(now-v.at>60_000) attempts.delete(k);
  };
  app.get('/healthz',async(_req,reply)=>{try{await store.getSetting('health:probe');return {ok:true,version:'0.3.0'};}catch{return reply.code(503).send({ok:false,error:'管理数据库暂时不可用'});}});
  app.get('/api/session',async req=>(await session(req)));
  app.post('/api/setup',async(req,reply)=>{
    rateLimit(req); if((await store.vault.has('admin'))) return reply.code(409).send({error:'管理员已设置，请直接登录。'});
    const body=z.object({password:z.string().min(12).max(256),setupToken:z.string().max(256)}).parse(req.body);
    if(!secureEqual(body.setupToken,setupToken)) return reply.code(403).send({error:'安装码不正确。请读取管理后台数据目录中的 setup-token 文件。'});
    const created=await store.transaction(async ()=>{
      if(await store.vault.has('admin'))return false;
      const salt=randomBytes(16).toString('hex');
      await store.vault.set('admin',{salt,hash:scryptSync(body.password,salt,64).toString('hex')});
      return true;
    });
    if(!created)return reply.code(409).send({error:'管理员已设置，请直接登录。'});
    return await issueSession(reply);
  });
  app.post('/api/login',async(req,reply)=>{
    rateLimit(req); const body=z.object({password:z.string().max(256)}).parse(req.body);
    const admin=(await store.vault.get<{salt:string;hash:string}>('admin'));
    if(!admin || !secureEqual(scryptSync(body.password,admin.salt,64).toString('hex'),admin.hash)) return reply.code(401).send({error:'密码不正确。'});
    return (await issueSession(reply));
  });
  app.post('/api/logout',async(req,reply)=>{if(req.sessionId) (await store.vault.delete(`session:${req.sessionId}`)); reply.clearCookie('serverdesk_session',{path:'/'});return {ok:true};});
  app.get('/api/agent/manifest',async()=>agentManifest());
  app.get('/api/agent/bundle',async(_req,reply)=>reply.type('application/gzip').send(agentBundle()));
  app.get('/api/agent/install.sh',async(_req,reply)=>reply.type('text/plain; charset=utf-8').send(agentInstaller()));
  app.post('/api/agent/register',async req=>{
    rateLimit(req);
    const body=z.object({pairingToken:z.string().min(16).max(256),hostname:z.string().min(1).max(255),version:z.string().min(1).max(64)}).strict().parse(req.body);
    const registered=(await agents.register(body));
    const server=(await requiredServer(registered.serverId));
    (await store.saveServer({...server,connectionMode:'agent',updatedAt:new Date().toISOString()}));
    return registered;
  });
  const asAgent=async <T>(req:FastifyRequest,operation:(serverId:string)=>Promise<T>):Promise<T>=>store.transaction(async ()=>{
    const serverId=await agents.authenticate(req.headers.authorization?.slice(7)??'');
    return operation(serverId);
  });
  app.post('/api/agent/poll',async req=>asAgent(req,serverId=>agents.poll(serverId,z.object({hostname:z.string().max(255),version:z.string().max(64),busy:z.boolean().optional(),deploymentProtection:z.object({mode:z.enum(['compatibility','strict']),policyVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict().optional()}).strict().parse(req.body))));
  app.post('/api/agent/commands/:id/ack',async req=>{await asAgent(req,serverId=>agents.acknowledge(serverId,paramId(req)));return {ok:true};});
  app.post('/api/agent/commands/:id/result',{bodyLimit:2*1024*1024},async req=>{
    const body=z.object({ok:z.boolean(),value:z.unknown().optional(),error:z.string().max(4096).optional(),outcomeKnown:z.boolean().optional()}).strict().parse(req.body);
    await asAgent(req,serverId=>agents.result(serverId,paramId(req),body));return {ok:true};
  });
  app.get('/api/workspace',async()=>{
    const data=await store.snapshot();
    const servers=await Promise.all(data.servers.map(async server=>({...server,agent:await agents.info(server.id)})));
    const serverStatuses=(await Promise.all(data.servers.map(server=>store.getSetting<ServerStatus>(`status:server:${server.id}`)))).filter(Boolean);
    const serviceStatuses=await Promise.all(data.services.map(async service=>{
      const value=await jobs.serviceStatus(service),error=service.autoDeploy?jobs.sourceError(service.id):undefined;
      return error?{...value,message:`自动发布检查失败：${error}`}:value;
    }));
    return {...data,servers,serverStatuses,serviceStatuses,integrations:await integrations(),platform:{storage:store.databaseKind,publisherConfigured:!!options.publisher,deploymentConfigurationAuthority:options.publisher?'publisher':'controller'},version:'0.3.0'};
  });
  const integrations=async ()=>{
    const services=await store.allServices();
    const webhooks=await Promise.all(services.map(service=>store.vault.has(`webhook:${service.id}`)));
    return {github:{connected:await store.vault.has('github'),login:await store.getSetting<string>('githubLogin'),...await store.getSetting<ConnectionStatus>('githubConnectionStatus')},vercel:{connected:await store.vault.has('vercel'),login:await store.getSetting<string>('vercelLogin'),...await store.getSetting<ConnectionStatus>('vercelConnectionStatus')},webhookConfigured:webhooks.some(Boolean),publicUrl:await store.getSetting<string>('publicUrl')};
  };
  app.post('/api/projects',async req=>{const body=projectSchema.parse(req.body),now=new Date().toISOString();const project:Project={...body,id:randomUUID(),serviceIds:[],createdAt:now,updatedAt:now};(await store.transaction(async ()=>{(await store.saveProject(project));if(body.serviceIds)(await store.moveServices(body.serviceIds,project.id));}));return (await store.getProject(project.id));});
  app.put('/api/projects/:id',async req=>{const id=paramId(req),body=projectSchema.parse(req.body);await store.transaction(async()=>{
    const current=await store.getProject(id);if(!current)throw new Error('项目不存在。');
    const value={...current,...body,serviceIds:body.serviceIds??current.serviceIds,updatedAt:new Date().toISOString()};
    if(current.serviceIds.some(serviceId=>!value.serviceIds.includes(serviceId)))throw new Error('服务必须属于项目，请在目标项目中选择服务进行移动，或删除服务。');
    await store.moveServices(value.serviceIds,id);await store.saveProject(value);
  });return await store.getProject(id);});
  app.delete('/api/projects/:id',async req=>{(await store.removeProject(paramId(req)));return {ok:true};});
  app.post('/api/servers',async req=>{const body=serverSchema.parse(req.body),now=new Date().toISOString();return (await store.saveServer({...body,id:randomUUID(),createdAt:now,updatedAt:now}));});
  app.put('/api/servers/:id',async req=>{
    const id=paramId(req),current=(await store.getServer(id));if(!current)throw new Error('服务器不存在。');
    const body=serverSchema.parse(req.body),identityChanged=body.host!==current.host || body.port!==current.port || body.username!==current.username;
    if(identityChanged && (await store.allJobs()).some(j=>j.serverId===id&&activeJob(j)))throw new Error('此服务器仍有任务待确认，请确认后再修改连接地址。');
    if(identityChanged && (await store.allServices()).some(s=>s.serverId===id&&s.autoDeploy))throw new Error('请先暂停此服务器上服务的自动发布，再修改连接地址。');
    if(identityChanged)for(const service of (await store.allServices()).filter(service=>service.serverId===id))await assertServiceDomainsRemoved(store,service.id);
    if(identityChanged){(await store.vault.delete(`ssh:${id}`));(await store.setSetting(`status:server:${id}`,null));}
    return (await store.saveServer({...current,...body,fingerprint:identityChanged?undefined:current.fingerprint,updatedAt:new Date().toISOString()}));
  });
  app.delete('/api/servers/:id',async req=>{(await store.removeServer(paramId(req)));return {ok:true};});
  app.post('/api/servers/:id/fingerprint',async req=>{
    const server=(await requiredServer(paramId(req)));const value=await remote.fingerprint(server);(await store.setSetting(`fingerprint:${server.id}`,{...value,at:Date.now(),identity:[server.host,server.port,server.username]}));return value;
  });
  app.post('/api/servers/:id/credentials',async req=>{
    if(options.publisher)throw new Error('独立发布器模式不保存 SSH 密码或私钥，请使用 void0 OS 连接服务器。');
    const server=(await requiredServer(paramId(req)));
    const body=z.object({password:z.string().max(16384).optional(),privateKey:z.string().max(65536).optional(),hostKey:z.string().max(8192),fingerprint:z.string().max(128)}).parse(req.body);
    const pending=(await store.getSetting<{hostKey:string;fingerprint:string;at:number;identity:string[]}>(`fingerprint:${server.id}`));
    if(!pending || Date.now()-pending.at>10*60*1000 || pending.hostKey!==body.hostKey || pending.fingerprint!==body.fingerprint || pending.identity.join('\0')!==[server.host,server.port,server.username].join('\0'))throw new Error('请重新读取并核对服务器指纹。');
    if(!body.password&&!body.privateKey)throw new Error('请填写 SSH 密码或私钥。');
    const value:SSHCredential={password:body.password||undefined,privateKey:body.privateKey||undefined,hostKey:body.hostKey};
    const verified={...server,fingerprint:body.fingerprint};
    if(remote.verifyConnection) await remote.verifyConnection(verified,value);
    let status:ServerStatus;try{status=await remote.probe(verified,value);if(status.error && !remote.verifyConnection)throw new Error(status.error);}catch(error){if(!remote.verifyConnection)throw error;status={serverId:server.id,checkedAt:new Date().toISOString(),error:'连接已核验，尚未读到资源状态。请检查并安装服务器依赖。'};}
    (await store.vault.set(`ssh:${server.id}`,value));(await store.saveServer({...server,fingerprint:body.fingerprint,updatedAt:new Date().toISOString()}));(await store.setSetting(`status:server:${server.id}`,status));return {ok:true};
  });
  app.delete('/api/servers/:id/credentials',async req=>{
    const id=paramId(req);
    await store.transaction(async()=>{
      if((await store.allJobs()).some(job=>job.serverId===id&&activeJob(job)))throw new Error('服务器仍有未结束的任务，不能删除登录凭据。');
      await store.vault.delete(`ssh:${id}`);
    });
    return {ok:true};
  });
  app.post('/api/servers/:id/refresh',async req=>jobs.refreshServer(paramId(req)));
  app.get('/api/servers/:id/agent',async req=>{const id=paramId(req);(await requiredServer(id));return (await agents.info(id));});
  app.post('/api/servers/:id/agent/pairing',async req=>{
    const id=paramId(req);(await requiredServer(id));
    const url=(await store.getSetting<string>('publicUrl'));
    if(!url||new URL(url).protocol!=='https:')throw new Error('请先在设置与连接中配置服务器可访问的 HTTPS 管理后台地址。');
    const pairing=(await agents.createPairing(id));
    return {...pairing,publicUrl:url,installCommand:`void0_install_dir=$(mktemp -d) && curl -fsSLo "$void0_install_dir/install.sh" ${shellQuote(url+'/api/agent/install.sh')} && sudo sh "$void0_install_dir/install.sh" ${shellQuote(url)}`};
  });
  app.post('/api/servers/:id/agent/revoke',async req=>{
    const id=paramId(req),server=(await requiredServer(id));(await agents.revoke(id));
    (await store.saveServer({...server,connectionMode:'ssh',updatedAt:new Date().toISOString()}));
    (await store.setSetting(`status:server:${id}`,null));return {ok:true};
  });
  app.post('/api/servers/:id/import',async req=>{
    const serverId=paramId(req);(await requiredServer(serverId));
    const body=z.object({projectId:idSchema,services:z.array(z.object({name:z.string().max(253),kind:z.enum(['Docker','Kubernetes']),composeProject:z.string().max(128).optional(),composeService:z.string().max(253).optional(),namespace:z.string().max(253).optional(),deployment:z.string().max(253).optional()}).passthrough()).min(1).max(1000)}).parse(req.body);
    if(!(await store.getProject(body.projectId)))throw new Error('目标项目不存在。');
    const status=(await store.getSetting<ServerStatus>(`status:server:${serverId}`));
    if(!status||status.error||Date.now()-Date.parse(status.checkedAt)>120_000)throw new Error('请重新读取服务器服务列表后再导入。');
    const selected=body.services.map(item=>{const found=(status.services??[]).find(row=>row.kind===item.kind&&(row.kind==='Kubernetes'?row.namespace===item.namespace&&row.deployment===item.deployment:row.composeProject?row.composeProject===item.composeProject&&row.composeService===item.composeService:row.name===item.name));if(!found)throw new Error('所选服务与服务器上实际发现的资源不一致。');return found;});
    let imported=0,ignored=0;const now=new Date().toISOString();
    (await store.transaction(async ()=>{for(const row of selected){
      const target=row.kind==='Kubernetes'?{namespace:row.namespace,deployment:row.deployment}:row.composeProject?{composeProject:row.composeProject,composeService:row.composeService}:{containerName:row.name};
      const kind:Service['kind']=row.kind==='Kubernetes'?'kubernetes':row.composeProject?'compose':'container';
      const existing=(await store.allServices()).find(s=>{if(s.serverId!==serverId)return false;if(kind==='compose'){const compose=managedComposeTarget(s);return compose?.project===target.composeProject&&compose?.service===target.composeService;}return s.kind===kind&&(kind==='kubernetes'?s.target.namespace===target.namespace&&s.target.deployment===target.deployment:s.target.containerName===target.containerName);});
      if(existing){if(!(await store.allProjects()).some(p=>p.serviceIds.includes(existing.id))){(await store.moveServices([existing.id],body.projectId));imported++;}else ignored++;continue;}
      const id=randomUUID();(await store.saveService({id,name:row.composeService??row.deployment??row.name,kind,serverId,target,image:row.image,autoDeploy:false,createdAt:now,updatedAt:now}));(await store.moveServices([id],body.projectId));imported++;
    }}));return {imported,ignored};
  });

  const runtimeSchema=z.enum(['docker','k3s']);
  app.get('/api/servers/:id/bootstrap',async req=>{
    const id=paramId(req);(await requiredServer(id));
    const {runtime}=z.object({runtime:runtimeSchema.default('docker')}).strict().parse(req.query);
    const k3s=runtime==='k3s';
    return {serverId:id,runtime,...(k3s?{version:DEFAULT_K3S_VERSION}:{}),requirements:k3s?['Ubuntu / Debian、systemd','至少 2 CPU、2GiB 内存，可用内存至少 1GiB、磁盘至少 4GiB','SSH 与已核验主机指纹','可执行无密码 sudo 的登录用户','可访问 K3s 官方下载地址']:['Ubuntu / Debian','SSH 与已核验主机指纹','可执行无密码 sudo 的登录用户'],commands:(k3s?k3sBootstrapScript():BOOTSTRAP_SCRIPT).trim().split('\n'),message:k3s?'安装独立的单节点 K3s；已有 K3s 仅检查，不改配置或升级。保留 Docker 服务，新集群禁用 Traefik 与 ServiceLB，安装 API 访问保护，不开放公网管理端口。':'仅安装缺少的服务器依赖；已有业务容器不会被删除或重新部署。安装可能需要几分钟。'};
  });
  app.post('/api/servers/:id/bootstrap',async req=>{
    const {runtime}=z.object({runtime:runtimeSchema.default('docker')}).strict().parse(req.body??{});
    return (await jobs.enqueueBootstrap(paramId(req),{runtime,...(runtime==='k3s'?{version:DEFAULT_K3S_VERSION}:{})}));
  });
  app.post('/api/services/:id/actions',async req=>{
    const {action}=z.object({action:z.enum(['restart','stop','start'])}).strict().parse(req.body);
    return (await jobs.enqueueKubernetes(paramId(req),action));
  });
  app.get('/api/services/:id/logs',async req=>jobs.kubernetesLogs(paramId(req)));
  app.get('/api/services/:id',async req=>{const value=(await store.getService(paramId(req)));if(!value)throw new Error('服务不存在。');return value;});
  const saveService=async(req:FastifyRequest,existing?:Service)=>{
    const body=serviceSchema.parse(req.body),now=new Date().toISOString();
    if(!existing&&!body.projectId)throw new Error('请先创建或选择项目，再添加服务。');
    if(options.publisher&&body.environment&&Object.keys(body.environment).length)throw new Error('独立发布器模式不在管理后台保存应用环境变量，请将变量保存在业务服务器本地文件。');
    if(existing && (await store.allJobs()).some(j=>j.serviceId===existing.id&&activeJob(j)))throw new Error('此服务仍有任务正在运行或结果待确认，请确认后再编辑。');
    if(existing && body.serverId && body.serverId!==existing.serverId)throw new Error('已有服务的服务器不能在编辑配置时更换，请单独迁移服务。');
    if(existing && body.kind && body.kind!==existing.kind)throw new Error('已有服务的运行类型不能直接更换。');
    const id=existing?.id??randomUUID();
    const kind=existing?.kind??body.kind;
    if(!kind || (!existing && !['source','image'].includes(kind)))throw new Error('新增服务请选择源码仓库或 Docker 镜像。');
    const value:Service={...(existing??{id,kind,target:{composeProject:'sd-'+id.toLowerCase().replaceAll('-',''),composeService:'app'},createdAt:now,autoDeploy:false}),...body,kind,updatedAt:now};
    delete (value as unknown as Record<string,unknown>).projectId;
    if(existing)await assertDomainTargetUnchanged(store,existing,value);
    if(value.repository) value.repository='https://github.com/'+repositoryName(value.repository);
    if(kind!=='vercel' && (!value.serverId || !(await store.getServer(value.serverId))))throw new Error('请选择已添加的服务器。');
    if(kind==='source' && !value.repository)throw new Error('请选择 GitHub 源码仓库。');
    if(kind==='image' && !options.publisher && !value.image)throw new Error('请填写 Docker 镜像地址。');
    if(value.hostPort&&!value.containerPort)throw new Error('发布服务器端口时需要填写容器端口。');
    if(value.autoDeploy && (!value.repository || !(options.publisher?['source','compose','image']:['source','compose']).includes(kind)))throw new Error('自动发布需要源码仓库和支持发布的 Docker 服务。');
    if(value.autoDeploy && !options.publisher && !(await store.vault.has('github')))throw new Error('请先连接 GitHub。');
    if(value.autoDeploy && (!value.serverId || !(await jobs.canControl(value.serverId))))throw new Error('请先接入在线的 void0 OS，或核验 SSH 指纹并保存登录凭据。');
    if(existing?.kind==='compose' && (body.environment!==undefined||body.volumes!==undefined||body.hostPort!==undefined||body.containerPort!==undefined))throw new Error('已关联的 Compose 服务沿用服务器上的环境、端口和数据卷，本次只配置源码发布。');
    await store.transaction(async()=>{
      if(body.projectId&&!(await store.getProject(body.projectId)))throw new Error('目标项目不存在。');
      const owner=existing?(await store.allProjects()).find(project=>project.serviceIds.includes(id)):undefined;
      if(owner&&body.projectId&&owner.id!==body.projectId)throw new Error('请通过目标项目的设置移动服务。');
      await store.saveService(value);if(body.projectId)await store.moveServices([id],body.projectId);
    });
    return (await store.getService(id));
  };
  app.post('/api/services',async req=>saveService(req));
  app.put('/api/services/:id',async req=>{const existing=(await store.getService(paramId(req)));if(!existing)throw new Error('服务不存在。');return saveService(req,existing);});
  app.delete('/api/services/:id',async req=>{await assertServiceDomainsRemoved(store,paramId(req));(await store.removeService(paramId(req)));return {ok:true};});
  app.post('/api/services/:id/deploy',async req=>(await jobs.enqueue(paramId(req))));
  app.post('/api/services/:id/refresh',async req=>jobs.refreshService(paramId(req)));
  app.get('/api/jobs/:id',async req=>{return jobs.refreshJob(paramId(req));});
  app.post('/api/jobs/:id/acknowledge',async req=>{const id=paramId(req),job=(await store.getJob(id));if(!job||job.state!=='unknown')throw new Error('只有结果待确认的任务可以结束跟踪。');return (await store.updateJob(id,{state:'cancelled',stage:'已结束跟踪，远端结果未确认',updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString()}));});
  const github=async ()=>{const token=await getProviderToken(store,'github');if(!token)throw new Error('请先连接 GitHub。');const value=await store.vault.get<ProviderCredential>('github');return new GitHub(token,fetch,value?.authorization==='github-app'?'github-app':undefined);};
  app.get('/api/github/repositories',async()=>({repositories:await (await github()).repositories()}));
  app.get('/api/github/branches',async req=>{const q=z.object({repository:z.string().max(256)}).parse(req.query);return {branches:await (await github()).branches(q.repository)};});
  app.get('/api/vercel/projects',async()=>{const value=await store.vault.get<ProviderCredential>('vercel');if(!value)throw new Error('请先连接 Vercel。');return {projects:await new Vercel(value.token,fetch,value.authorization==='vercel-integration'?(value.teamId??value.userId):value.teamId).projects()};});
  app.post('/api/vercel/import',async req=>{
    const body=z.object({projectId:idSchema,projectIds:z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1).max(500).refine(ids=>new Set(ids).size===ids.length)}).parse(req.body);
    if(!(await store.getProject(body.projectId)))throw new Error('目标项目不存在。');
    const credential=await store.vault.get<ProviderCredential>('vercel');const token=credential?.token;if(!token)throw new Error('请先连接 Vercel。');
    const catalog=await new Vercel(token,fetch,credential?.authorization==='vercel-integration'?(credential.teamId??credential.userId):credential?.teamId).projects();
    const selected=body.projectIds.map(id=>{const value=catalog.find(p=>p.id===id);if(!value)throw new Error('所选项目已无法通过当前 Vercel 连接访问，请重新读取项目列表。');return value;});
    const now=new Date().toISOString();await store.transaction(async()=>{
      if(!await store.getProject(body.projectId))throw new Error('目标项目不存在。');
      if((await store.vault.get<{token:string}>('vercel'))?.token!==token)throw new Error('Vercel 连接已变更，请重新读取项目列表。');
      for(const p of selected){
        const existing=(await store.allServices()).find(s=>s.kind==='vercel'&&s.target.vercelProjectId===p.id);
        const owner=existing?(await store.allProjects()).find(project=>project.serviceIds.includes(existing.id)):undefined;
        if(owner&&owner.id!==body.projectId)throw new Error('所选 Vercel 服务已属于其他项目，请通过目标项目的设置移动服务。');
        const id=existing?.id??randomUUID();
        await store.saveService(existing??{id,name:p.name,kind:'vercel',target:{vercelProjectId:p.id,vercelScopeId:p.accountId,vercelScopeSlug:p.scopeSlug},autoDeploy:false,createdAt:now,updatedAt:now});await store.moveServices([id],body.projectId);
      }
    });return {ok:true,count:selected.length};
  });
  const publisherCatalog=async ()=>{
    if(!options.publisher)throw new Error('尚未配置独立发布器。');
    const catalog=await options.publisher.catalog();
    if(!Array.isArray(catalog)||catalog.length>1000)throw new Error('发布器服务目录无效。');
    const seen=new Set<string>();
    return catalog.map(({service,server})=>{
      if(!service||!server||!idSchema.safeParse(service.id).success||!idSchema.safeParse(server.id).success||service.serverId!==server.id||service.kind!=='image'||server.connectionMode!=='agent'||!service.target||Object.keys(service.target).length||seen.has(service.id))throw new Error('发布器服务目录包含无效或重复的部署目标。');
      seen.add(service.id);
      const safeService:Service={id:service.id,name:service.name,kind:service.kind,serverId:service.serverId,target:{},image:service.image,repository:service.repository,branch:service.branch,dockerfile:service.dockerfile,context:service.context,containerPort:service.containerPort,hostPort:service.hostPort,volumes:service.volumes?structuredClone(service.volumes):undefined,autoDeploy:!!service.autoDeploy,createdAt:service.createdAt,updatedAt:service.updatedAt};
      const safeServer:Server={id:server.id,name:server.name,host:server.host,port:server.port,username:server.username,group:server.group,notes:server.notes,connectionMode:'agent',createdAt:server.createdAt,updatedAt:server.updatedAt};
      return {service:safeService,server:safeServer};
    });
  };
  app.get('/api/publisher/services',async()=>({services:await publisherCatalog()}));
  app.post('/api/publisher/import',async req=>{
    const body=z.object({projectId:idSchema,serviceIds:z.array(idSchema).min(1).max(500).refine(ids=>new Set(ids).size===ids.length)}).strict().parse(req.body);
    const catalog=await publisherCatalog();
    const selected=body.serviceIds.map(id=>{const entry=catalog.find(item=>item.service.id===id);if(!entry)throw new Error('所选服务已不在发布器授权目录中，请重新读取。');return entry;});
    await store.transaction(async()=>{
      if(!await store.getProject(body.projectId))throw new Error('目标项目不存在。');
      for(const {service:incoming} of selected){
        const server=await store.getServer(incoming.serverId!);
        if(!server||server.connectionMode!=='agent')throw new Error('请先添加并接入发布器指定的 void0 OS 服务器，再导入服务。');
        const existing=await store.getService(incoming.id);
        if(existing&&Object.keys(await store.getServiceEnvironment(existing.id)).length)throw new Error('此服务仍有保存在后台的环境变量；请先移至业务服务器本地文件并清除、撤销或轮换旧凭据，再导入。');
        if((await store.allJobs()).some(job=>activeJob(job)&&(job.serviceId===incoming.id||(job.serverId===server.id&&job.type==='bootstrap'))))throw new Error('服务或服务器仍有未结束的任务，不能重新导入。');
        if(existing&&(existing.kind!==incoming.kind||existing.serverId!==incoming.serverId||!isDeepStrictEqual(existing.target,incoming.target)))throw new Error('已有服务的运行类型、服务器或部署目标与发布器不一致，导入已取消。');
        const now=new Date().toISOString();
        await store.saveService({...incoming,autoDeploy:existing?.autoDeploy??false,createdAt:existing?.createdAt??now,updatedAt:now});
        await store.moveServices([incoming.id],body.projectId);
      }
    });
    return {ok:true,count:selected.length};
  });
  app.post('/api/settings',async req=>{const body=z.object({publicUrl:z.string().max(1024).optional()}).parse(req.body);if(body.publicUrl!==undefined)(await store.setSetting('publicUrl',body.publicUrl?publicUrl(body.publicUrl):null));return {ok:true};});
  app.post('/api/services/:id/webhook',async req=>{
    const service=(await store.getService(paramId(req)));if(!service?.repository)throw new Error('服务没有配置 GitHub 源码仓库。');
    const base=(await store.getSetting<string>('publicUrl'));if(!base||!base.startsWith('https://'))throw new Error('安装通知前请设置可公开访问的 HTTPS 管理地址；未设置时后台仍每分钟检查一次代码更新。');
    const secret=randomBytes(32).toString('hex');const url=`${base}/api/hooks/github/${service.id}`;
    await (await github()).registerWebhook(service.repository,url,secret);(await store.vault.set(`webhook:${service.id}`,{secret}));return {ok:true,url};
  });
  app.post('/api/hooks/github/:id',async(req,reply)=>{
    const id=paramId(req),service=(await store.getService(id)),secret=(await store.vault.get<{secret:string}>(`webhook:${id}`))?.secret;
    if(!service||!secret||!validWebhook(secret,req.headers['x-hub-signature-256'] as string|undefined,req.rawBody??Buffer.alloc(0)))return reply.code(403).send({error:'通知签名无效。'});
    const event=req.headers['x-github-event'];if(event==='ping')return {ok:true};if(event!=='push'||!service.autoDeploy)return {ok:true,ignored:true};
    const body=z.object({ref:z.string(),after:z.string().regex(/^[a-f0-9]{40}$/),deleted:z.boolean().optional(),repository:z.object({full_name:z.string()})}).parse(req.body);
    if(body.deleted||body.ref!==`refs/heads/${service.branch??'main'}`||repositoryName(body.repository.full_name).toLowerCase()!==repositoryName(service.repository??'').toLowerCase())return {ok:true,ignored:true};
    if((await store.allJobs()).some(j=>j.serviceId===id&&(j.revision===body.after||activeJob(j))))return {ok:true,ignored:true};
    (await jobs.enqueue(id,'github',body.after));return reply.code(202).send({ok:true});
  });
  async function requiredServer(id:string):Promise<Server> {const server=(await store.getServer(id));if(!server)throw new Error('服务器不存在。');return server;}
  registerConnectionRoutes(app,{store,publisherConfigured:!!options.publisher});
  registerProviderOAuth(app,{store,publisherConfigured:!!options.publisher});
  registerDomainRoutes(app,{store,remote});
  const webRoot=resolve(options.webRoot??'dist/web');
  if(existsSync(join(webRoot,'index.html'))){await app.register(staticFiles,{root:webRoot,prefix:'/',index:['index.html']});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在。'}):reply.sendFile('index.html'));}
  app.addHook('onClose',async()=>{jobs.stop();(await agents.close());(await store.close());});
  if(options.startWorker!==false)(await jobs.start());
  return {app,store,jobs,agents};
}
function paramId(req:FastifyRequest):string {return z.object({id:idSchema}).parse(req.params).id;}
function secureEqual(input:unknown,expected:string|undefined):boolean {if(typeof input!=='string'||!expected)return false;const a=Buffer.from(input),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
function publicUrl(input:string):string {const url=new URL(input);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('请填写不含路径、密码或参数的管理地址。');if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('公网管理地址需要使用 HTTPS。');return url.origin;}

function shellQuote(value:string):string {return "'"+value.replaceAll("'", "'\\''")+"'";}
