import { randomUUID } from 'node:crypto';
import type { BootstrapOptions, DeployPlan, Job, KubernetesAction, RemoteTransport, ServerStatus, Service, ServiceStatus, SSHCredential } from '../shared/types.js';
import type { Store } from './store.js';
import { GitHub, repositoryName, Vercel } from './integrations.js';
import { getProviderToken,type ProviderCredential } from './provider-oauth.js';
import type {PublisherClient} from './publisher.js';
import {managedComposeTarget} from '../shared/service-target.js';

export function activeJob(job:Job):boolean { return ['queued','running','unknown'].includes(job.state); }
export class JobManager {
  private ticking=false;
  private stopped=false;
  private timer?:ReturnType<typeof setInterval>;
  private active=new Set<string>();
  private lastGithubPoll=0;
  private lastProbe=0;
  private lastVercelPoll=0;
  private errors=new Map<string,string>();
  constructor(readonly store:Store,readonly remote:RemoteTransport,readonly publisher?:Pick<PublisherClient,'revision'|'publish'>) {}
  async start() {
    if(this.timer) return; this.stopped=false;
    // A prior running job is only reconciled, never submitted again.
    for(const job of (await this.store.allJobs())) if(job.state==='running' && job.type!=='deploy') (await this.store.updateJob(job.id,{state:'unknown',stage:job.type==='bootstrap'?'安装结果待确认':'操作结果待确认',message:'管理后台曾中断，请检查服务器实际状态；此操作不会自动重发。',updatedAt:new Date().toISOString()}));
    const tick=()=>{void this.tick().catch(error=>{if(!this.stopped)this.errors.set('__worker',safeMessage(error));});};
    this.timer=setInterval(tick,2_000);this.timer.unref();tick();
  }
  stop() { this.stopped=true; if(this.timer) clearInterval(this.timer); this.timer=undefined; }
  async canControl(serverId:string):Promise<boolean> { const server=(await this.store.getServer(serverId));return !!server && (this.remote.canControl?(await this.remote.canControl(server)):Boolean((await this.credentials(serverId))?.hostKey)); }
  async credentials(serverId:string):Promise<SSHCredential|undefined> { return (await this.store.vault.get<SSHCredential>(`ssh:${serverId}`)); }
  async tick() {
    if(this.ticking||this.stopped) return; this.ticking=true;
    try {
      for(const job of (await this.store.allJobs()).filter(j=>['running','unknown'].includes(j.state) && !this.active.has(j.id))) {await this.refreshJob(job.id);if(this.stopped)return;}
      const occupied=(await this.store.allJobs()).some(j=>j.state==='running');
      if(this.stopped)return;
      if(!occupied) { const queued=(await this.store.allJobs()).filter(j=>j.state==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]; if(queued&&!this.stopped)void this.run(queued).catch(error=>{if(!this.stopped)this.errors.set(queued.serviceId,safeMessage(error));}); }
      if(Date.now()-this.lastGithubPoll>60_000) { this.lastGithubPoll=Date.now(); await this.checkSources();if(this.stopped)return; }
      if((await this.store.vault.has('vercel')) && Date.now()-this.lastVercelPoll>60_000){this.lastVercelPoll=Date.now();await Promise.allSettled((await this.store.allServices()).filter(s=>s.kind==='vercel').map(s=>this.refreshService(s.id)));}
      if(this.stopped)return;
      if(Date.now()-this.lastProbe>30_000) { this.lastProbe=Date.now(); await Promise.allSettled((await this.store.allServers()).map(async server=>{if(await this.canControl(server.id))await this.refreshServer(server.id);})); }
    } finally { this.ticking=false; }
  }
  async enqueue(serviceId:string,source:'manual'|'github'='manual',revision?:string):Promise<Job> {
    const service=(await this.store.getService(serviceId));
    if(!service || !service.serverId) throw new Error('服务或目标服务器不存在。');
    if(!['source','image','compose'].includes(service.kind)) throw new Error('此服务当前只支持查看状态，不能通过这里发布。');
    if(service.kind==='compose' && !service.repository) throw new Error('请为现有服务选择源码仓库，原有部署不会重复创建。');
    const server=(await this.store.getServer(service.serverId)); if(!server) throw new Error('目标服务器不存在。');
    if(!(await this.canControl(server.id))) throw new Error('请先接入在线的 void0 OS，或核验 SSH 指纹并保存登录凭据。');
    if((await this.store.allJobs()).some(j=>j.serviceId===serviceId && activeJob(j))) throw new Error('此服务仍有任务正在运行或结果待确认。');
    if(!this.publisher && service.repository && !(await this.store.vault.has('github'))) throw new Error('请先连接 GitHub。');
    const now=new Date().toISOString();
    const job:Job={id:randomUUID(),serviceId,serverId:server.id,type:'deploy',source,state:'queued',stage:'等待发布',revision,log:'',createdAt:now,updatedAt:now};
    // Store the queue entry and immutable plan together, so a crash cannot leave
    // a job that would be reconstructed from later edits.
    (await this.store.transaction(async ()=>{(await this.store.enqueue(job));(await this.store.vault.set(`plan:${job.id}`,{service,server}));}));
    return job;
  }
  async enqueueBootstrap(serverId:string,options:BootstrapOptions={runtime:'docker'}):Promise<Job> {
    const server=(await this.store.getServer(serverId)); if(!server) throw new Error('服务器不存在。');
    if(!(await this.canControl(serverId))) throw new Error('请先接入在线的 void0 OS，或核验 SSH 指纹并保存登录凭据。');
    if((await this.store.allJobs()).some(j=>j.serverId===serverId && activeJob(j))) throw new Error('此服务器仍有任务正在运行或结果待确认。');
    if(!['docker','k3s'].includes(options.runtime??'docker'))throw new Error('安装方式无效。');
    const now=new Date().toISOString();
    const job:Job={id:randomUUID(),serverId,serviceId:'',type:'bootstrap',bootstrap:options,source:'manual',state:'queued',stage:'等待检查与安装',log:'',createdAt:now,updatedAt:now};
    (await this.store.transaction(async ()=>{(await this.store.enqueue(job));(await this.store.vault.set(`plan:${job.id}`,{server}));}));return job;
  }
  async enqueueKubernetes(serviceId:string,action:Exclude<KubernetesAction,'logs'>):Promise<Job> {
    if(!['restart','stop','start'].includes(action))throw new Error('服务操作无效。');
    const service=(await this.kubernetesService(serviceId));
    const server=(await this.store.getServer(service.serverId!))!;
    if(!this.remote.kubernetesAction)throw new Error('当前连接不支持 K3s 管理。');
    if((await this.store.allJobs()).some(job=>job.serviceId===serviceId&&activeJob(job)))throw new Error('此服务仍有任务正在运行或结果待确认。');
    const now=new Date().toISOString();
    const labels={restart:'等待重启服务',stop:'等待停止服务',start:'等待启动服务'};
    const job:Job={id:randomUUID(),serviceId,serverId:server.id,type:'kubernetes',action,source:'manual',state:'queued',stage:labels[action],log:'',createdAt:now,updatedAt:now};
    (await this.store.transaction(async ()=>{(await this.store.enqueue(job));(await this.store.vault.set(`plan:${job.id}`,{server,service}));}));return job;
  }
  private async kubernetesService(id:string):Promise<Service> {
    const service=(await this.store.getService(id));
    if(!service || service.kind!=='kubernetes' || !service.serverId || !(await this.store.getServer(service.serverId)))throw new Error('请选择已关联服务器的 Kubernetes 服务。');
    const {namespace,deployment}=service.target;
    if(!namespace||!deployment||!validKubernetesName(namespace,63)||namespace.includes('.')||!validKubernetesName(deployment,253))throw new Error('Kubernetes 服务目标无效。');
    if(!(await this.canControl(service.serverId)))throw new Error('请先接入在线的 void0 OS，或核验 SSH 指纹并保存登录凭据。');
    return service;
  }
  async kubernetesLogs(serviceId:string):Promise<{log:string}> {
    const service=(await this.kubernetesService(serviceId));
    const server=(await this.store.getServer(service.serverId!))!;
    if(!this.remote.kubernetesAction)throw new Error('当前连接不支持 K3s 管理。');
    try {
      const result=await this.remote.kubernetesAction(server,(await this.credentials(server.id)),{namespace:service.target.namespace!,deployment:service.target.deployment!},'logs');
      if(this.stopped)throw new Error('管理后台已停止。');
      return {log:(await this.redactLog(result.log,service.id,server.id))};
    } catch(error) {
      if(this.stopped)throw new Error('管理后台已停止。');
      throw new Error((await this.redactLog(safeMessage(error),service.id,server.id)));
    }
  }
  private async redactLog(log:string,serviceId:string,serverId:string):Promise<string> {
    const credential=(await this.credentials(serverId));
    const relatedServices=(await this.store.allServices()).filter(service=>service.id===serviceId||service.serverId===serverId);
    const environments=await Promise.all(relatedServices.map(service=>this.store.getServiceEnvironment(service.id)));
    const secrets=[...environments.flatMap(environment=>Object.values(environment)),credential?.password,credential?.privateKey].filter((v):v is string=>typeof v==='string'&&v.length>=4);
    let value=String(log).slice(-128*1024);
    for(const secret of secrets) value=value.replaceAll(secret,'[已隐藏]');
    return value.replace(/(\b(?:password|passwd|secret|token|authorization|api[_-]?key)\b\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,'$1[已隐藏]').replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [已隐藏]').replace(/((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已隐藏]@');
  }
  private async run(job:Job) {
    if(this.stopped||this.active.has(job.id))return;this.active.add(job.id);
    let submitted=false;
    try {
      await this.store.updateJob(job.id,{state:'running',stage:job.type==='bootstrap'?`检查并安装 ${job.bootstrap?.runtime==='k3s'?'K3s':'Docker'} 依赖`:job.type==='kubernetes'?'执行服务操作':'准备代码',updatedAt:new Date().toISOString()});
      if(this.stopped)return;
      const saved=(await this.store.vault.get<{service:Service;server:DeployPlan['server']}>(`plan:${job.id}`));
      const server=saved?.server??(await this.store.getServer(job.serverId)); if(!server) throw new Error('目标服务器不存在。');
      const credential=(await this.credentials(server.id));
      if(this.stopped)return;
      if(job.type==='bootstrap') {
        submitted=true;
        const result=await this.remote.bootstrap(server,credential,job.bootstrap??{runtime:'docker'});
        if(this.stopped)return;
        (await this.store.updateJob(job.id,{state:'succeeded',stage:'依赖已就绪',log:(await this.redactLog(result.log,'',server.id)),updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString()}));
        await this.refreshServer(server.id); return;
      }
      const service=saved?.service??(await this.store.getService(job.serviceId)); if(!service) throw new Error('服务资料不存在。');
      if(job.type==='kubernetes') {
        if(!this.remote.kubernetesAction||!job.action||service.kind!=='kubernetes'||!service.target.namespace||!service.target.deployment)throw new Error('Kubernetes 操作或目标无效。');
        submitted=true;
        const result=await this.remote.kubernetesAction(server,credential,{namespace:service.target.namespace,deployment:service.target.deployment},job.action);
        if(this.stopped)return;
        const labels={restart:'服务已重启',stop:'服务已停止',start:'服务已启动'};
        (await this.store.updateJob(job.id,{state:'succeeded',stage:labels[job.action],log:(await this.redactLog(result.log,service.id,server.id)),updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString()}));
        await this.refreshServer(server.id);return;
      }
      if(this.publisher) {
        if(!this.remote.submitSigned||server.connectionMode!=='agent')throw new Error('受保护发布需要 void0 OS 和独立发布器。');
        await this.store.updateJob(job.id,{stage:'独立发布器正在构建与签名',updatedAt:new Date().toISOString()});
        const release=await this.publisher.publish(service.id,job.id);
        if(this.stopped)return;
        const plan=release.payload.plan;
        if(plan.job.id!==job.id||plan.service.id!==service.id||plan.server.id!==server.id||plan.service.serverId!==server.id)throw new Error('发布器返回了其他服务或服务器的发布内容。');
        await this.store.updateJob(job.id,{revision:plan.job.revision,stage:'服务器正在校验发布授权',updatedAt:new Date().toISOString()});
        submitted=true;
        const result=await this.remote.submitSigned(release,server);
        if(this.stopped)return;
        await this.store.updateJob(job.id,{...result,state:result.state==='queued'?'running':result.state,updatedAt:new Date().toISOString(),...(isTerminal(result.state)?{finishedAt:new Date().toISOString()}:{} )});
        await this.rememberSuccessfulVersion(job.id);return;
      }
      service.environment=(await this.store.getServiceEnvironment(service.id));
      let repository:DeployPlan['repository'];
      if(service.repository) {
        const token=await getProviderToken(this.store,'github'); if(!token) throw new Error('GitHub 尚未连接。');
        const gh=new GitHub(token); const name=repositoryName(service.repository);
        const latest=await gh.commit(name,service.branch??'main');
        if(this.stopped)return;
        if(job.source==='github' && job.revision && job.revision!==latest){(await this.store.updateJob(job.id,{state:'cancelled',stage:'已有更新提交，跳过旧版本',updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString()}));return;}
        const commit=job.revision??latest;
        await gh.dockerfile(name,service.dockerfile??'Dockerfile',commit);
        if(this.stopped)return;
        const [owner,repo]=name.split('/'); repository={owner,repo,commit,token};
        (await this.store.updateJob(job.id,{revision:commit,stage:'传输构建代码',updatedAt:new Date().toISOString()}));
      }
      const current=(await this.store.getJob(job.id))!;
      if(this.stopped)return;
      // Any submission error may follow a successful remote handoff. Keep it unknown.
      submitted=true;
      const remote=await this.remote.submit({service,server,job:current,repository},credential);
      if(this.stopped)return;
      (await this.store.updateJob(job.id,{...remote,state:remote.state==='queued'?'running':remote.state,updatedAt:new Date().toISOString(),...(isTerminal(remote.state)?{finishedAt:new Date().toISOString()}:{} )}));
      (await this.rememberSuccessfulVersion(job.id));
    } catch(error) {
      if(this.stopped)return;
      const message=(await this.redactLog(safeMessage(error),job.serviceId,job.serverId));
      const uncertain=submitted && !(error instanceof Error && 'outcomeKnown' in error && error.outcomeKnown===true);
      (await this.store.updateJob(job.id,{state:uncertain?'unknown':'failed',stage:uncertain?'执行结果待确认':'执行失败',message,log:message,updatedAt:new Date().toISOString(),...(!uncertain?{finishedAt:new Date().toISOString()}:{} )}));
    } finally { this.active.delete(job.id); }
  }
  async refreshJob(id:string):Promise<Job> {
    const job=(await this.store.getJob(id)); if(!job) throw new Error('任务不存在。');
    if(job.type!=='deploy' || this.active.has(id) || !['running','unknown'].includes(job.state)) return job;
    const server=(await this.store.getServer(job.serverId)); if(!server) return job;
    try {
      const remote=await this.remote.status(job,server,(await this.credentials(server.id)));
      if(this.stopped)return job;
      (await this.store.updateJob(id,{...remote,state:remote.state==='queued'?'running':remote.state,updatedAt:new Date().toISOString(),...(isTerminal(remote.state)?{finishedAt:new Date().toISOString()}:{} )}));
      (await this.rememberSuccessfulVersion(id));
    } catch(error) {
      if(this.stopped)return job;
      (await this.store.updateJob(id,{message:'无法读取远端结果：'+safeMessage(error),updatedAt:new Date().toISOString()}));
    }
    return (await this.store.getJob(id))!;
  }
  private async rememberSuccessfulVersion(id:string) {
    const job=(await this.store.getJob(id)); if(job?.state!=='succeeded' || !job.revision) return;
    const service=(await this.store.getService(job.serviceId)); if(service) (await this.store.saveService({...service,lastCommit:job.revision,updatedAt:new Date().toISOString()}));
  }
  async refreshServer(id:string):Promise<ServerStatus> {
    const server=(await this.store.getServer(id)); if(!server) throw new Error('服务器不存在。');
    let status:ServerStatus;
    try { status=await this.remote.probe(server,(await this.credentials(id))); }
    catch(error) { status={serverId:id,checkedAt:new Date().toISOString(),error:safeMessage(error)}; }
    if(!this.stopped)(await this.store.setSetting(`status:server:${id}`,status)); return status;
  }
  async refreshService(id:string):Promise<ServiceStatus> {
    const service=(await this.store.getService(id)); if(!service) throw new Error('服务不存在。');
    if(service.kind==='vercel') {
      const credential=await this.store.vault.get<ProviderCredential>('vercel');const token=credential?.token;
      let status:ServiceStatus;
      try { if(!token) throw new Error('Vercel 尚未连接。'); status=await new Vercel(token,fetch,credential?.authorization==='vercel-integration'?(credential.teamId??credential.userId):credential?.teamId).status(service); }
      catch(error) { status={serviceId:id,state:'error',ready:false,message:safeMessage(error),checkedAt:new Date().toISOString()}; }
      if(!this.stopped)(await this.store.setSetting(`status:service:${id}`,status)); return status;
    }
    if(service.serverId) await this.refreshServer(service.serverId);
    if(this.stopped)return {serviceId:id,state:'unknown',ready:false,message:'管理后台已停止',checkedAt:new Date().toISOString()};
    return (await this.serviceStatus(service));
  }
  async serviceStatus(service:Service):Promise<ServiceStatus> {
    if(service.kind==='vercel') return (await this.store.getSetting<ServiceStatus>(`status:service:${service.id}`))??{serviceId:service.id,state:'unknown',ready:false,message:'尚未读取 Vercel 状态',checkedAt:new Date(0).toISOString()};
    const active=(await this.store.allJobs()).find(j=>j.serviceId===service.id && j.state==='running');
    if(active) return {serviceId:service.id,state:'deploying',ready:false,message:active.stage,checkedAt:active.updatedAt};
    const status=(await this.store.getSetting<ServerStatus>(`status:server:${service.serverId}`));
    if(!status || status.error) return {serviceId:service.id,state:status?.error?'error':'unknown',ready:false,message:status?.error??'尚未读取服务器状态',checkedAt:status?.checkedAt??new Date(0).toISOString()};
    const compose=managedComposeTarget(service);
    const matches=(status.services??[]).filter(row=>compose ? row.kind==='Docker' && row.composeProject===compose.project && row.composeService===compose.service : service.kind==='kubernetes'?row.kind==='Kubernetes' && row.namespace===service.target.namespace && row.deployment===service.target.deployment : service.kind==='container'?row.kind==='Docker' && row.name===service.target.containerName : false);
    const ready=matches.length>0 && matches.every(row=>row.ready);
    return {serviceId:service.id,state:ready?'running':matches.length?'stopped':'unknown',ready,message:matches.length===1?matches[0].state:matches.length?`${matches.filter(r=>r.ready).length}/${matches.length} 已就绪`:'未找到对应运行实例',checkedAt:status.checkedAt,image:matches.length===1?matches[0].image:undefined};
  }
  async checkSources() {
    const token=await getProviderToken(this.store,'github'); if(!token&&!this.publisher) return;
    const gh=new GitHub(token??'');
    for(const service of (await this.store.allServices()).filter(s=>s.autoDeploy && (s.repository || (this.publisher && s.serverId && s.kind==='image')))) {
      try {
        const commit=this.publisher?await this.publisher.revision(service.id):await gh.commit(service.repository!,service.branch??'main');
        if(this.stopped)return;
        if(service.lastCommit===commit || (await this.store.allJobs()).some(j=>j.serviceId===service.id && j.revision===commit)) continue;
        if((await this.store.allJobs()).some(j=>j.serviceId===service.id && activeJob(j))) continue;
        (await this.enqueue(service.id,'github',commit)); this.errors.delete(service.id);
      } catch(error) { this.errors.set(service.id,safeMessage(error)); }
    }
  }
  sourceError(id:string) { return this.errors.get(id); }
}
export function isTerminal(state:Job['state']) { return ['succeeded','failed','rolled_back','rollback_failed','cancelled'].includes(state); }
export function safeMessage(error:unknown):string {
  return error instanceof Error?error.message.slice(0,1500):'操作未完成，请检查配置后重试。';
}
function validKubernetesName(value:string,maximum:number):boolean {
  return value.length<=maximum && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && value.split('.').every(part=>part.length>0&&part.length<=63&&!part.startsWith('-')&&!part.endsWith('-'));
}
