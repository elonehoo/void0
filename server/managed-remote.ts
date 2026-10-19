import type {BootstrapOptions,DeployPlan,DomainOperation,DockerDomainState,Job,KubernetesAction,KubernetesActionResult,RemoteJobStatus,RemoteTransport,Server,ServerStatus,SSHCredential,SignedRelease} from '../shared/types.js';
import type {Store} from './store.js';
import type {AgentController} from './agent-controller.js';
import {SSHRemote} from './remote.js';
import {remoteJobStatus} from './remote-status.js';
import {dockerDomainState} from './domains.js';

/** Select one explicit connection per server; an offline Agent never falls back to another host. */
export class ManagedRemote implements RemoteTransport {
  constructor(readonly store:Store,readonly agents:AgentController,readonly ssh=new SSHRemote({dataDir:store.rootDirectory})) {}
  async canControl(server:Server):Promise<boolean> {
    return server.connectionMode==='agent'?(await this.agents.info(server.id)).online:!!(await this.store.vault.get<SSHCredential>(`ssh:${server.id}`))?.hostKey;
  }
  fingerprint(server:Server){return this.ssh.fingerprint(server);}
  verifyConnection(server:Server,credential:SSHCredential|undefined){return this.ssh.verifyConnection(server,credential);}
  async probe(server:Server,credential:SSHCredential|undefined):Promise<ServerStatus> {
    if(server.connectionMode!=='agent')return this.ssh.probe(server,credential);
    const value=await this.agents.command(server.id,'probe',{},90_000);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('void0 OS 返回的服务器状态无效。');
    return {...value as ServerStatus,serverId:server.id,checkedAt:new Date().toISOString()};
  }
  async bootstrap(server:Server,credential:SSHCredential|undefined,options?:BootstrapOptions):Promise<{log:string}> {
    if(server.connectionMode!=='agent')return this.ssh.bootstrap(server,credential,options);
    const value=await this.agents.command(server.id,'bootstrap',options??{runtime:'docker'},15*60_000);
    if(!value||typeof value!=='object'||!('log'in value)||typeof value.log!=='string')throw new Error('void0 OS 未返回有效的安装结果。');
    return {log:value.log};
  }
  async kubernetesAction(server:Server,credential:SSHCredential|undefined,target:{namespace:string;deployment:string},action:KubernetesAction,options?:{replicas?:number}):Promise<KubernetesActionResult> {
    if(server.connectionMode!=='agent')return this.ssh.kubernetesAction(server,credential,target,action,options);
    const value=await this.agents.command(server.id,'kubernetes-action',{target,action,options},180_000);
    if(!value||typeof value!=='object'||!('log'in value)||typeof value.log!=='string')throw new Error('void0 OS 未返回有效的服务操作结果。');
    return value as KubernetesActionResult;
  }
  async submit(plan:DeployPlan,credential:SSHCredential|undefined):Promise<RemoteJobStatus> {
    if(plan.server.connectionMode!=='agent')return this.ssh.submit(plan,credential);
    const archive=plan.repository?await this.ssh.repositoryArchive(plan.repository):undefined;
    if(archive&&archive.length>20*1024*1024)throw Object.assign(new Error('void0 OS 部署的源码归档不能超过 20MiB，请缩减仓库归档。'),{outcomeKnown:true});
    const safePlan={...plan,repository:plan.repository?{owner:plan.repository.owner,repo:plan.repository.repo,commit:plan.repository.commit}:undefined};
    return remoteJobStatus(await this.agents.command(plan.server.id,'submit',{plan:safePlan,archive:archive?.toString('base64')},180_000));
  }
  async submitSigned(release:SignedRelease,server:Server):Promise<RemoteJobStatus> {
    if(server.connectionMode!=='agent'||release.payload.plan.server.id!==server.id)throw Object.assign(new Error('受保护发布只能发送给对应的 void0 OS。'),{outcomeKnown:true});
    return remoteJobStatus(await this.agents.command(server.id,'submit',{...release.payload,authorization:release.authorization},180_000));
  }
  async domain(server:Server,credential:SSHCredential|undefined,operation:DomainOperation):Promise<DockerDomainState> {
    if(server.connectionMode!=='agent')return this.ssh.domain(server,credential,operation);
    const info=await this.agents.info(server.id);
    if(info.deploymentProtection.mode==='strict')throw Object.assign(new Error('此服务器启用了独立发布保护，网页不能直接修改域名；请由服务器管理员配置。'),{outcomeKnown:true});
    try {
      const value=await this.agents.command(server.id,'domain',operation,240_000);
      const error=value as {error?:unknown;outcomeKnown?:unknown};
      if(error?.error)throw Object.assign(new Error(typeof error.error==='string'?error.error:'域名操作失败。'),{outcomeKnown:error.outcomeKnown===true});
      return dockerDomainState(value);
    }catch(error){
      if(error instanceof Error&&/not supported|unavailable|not available/.test(error.message))throw Object.assign(new Error('服务器上的 void0 OS 尚不支持域名管理，请更新 void0 OS。'),{outcomeKnown:true});
      throw error;
    }
  }
  async status(job:Job,server:Server,credential:SSHCredential|undefined):Promise<RemoteJobStatus> {
    if(server.connectionMode!=='agent')return this.ssh.status(job,server,credential);
    if(job.serverId!==server.id)throw new Error('任务与服务器不匹配。');
    return remoteJobStatus(await this.agents.command(server.id,'status',{jobId:job.id},60_000));
  }
}
