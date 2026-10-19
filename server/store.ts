import type { Job, Project, Server, Service } from '../shared/types.js';
import { privateDirectory, Vault } from './vault.js';
import { PostgreSQLStorage, SQLiteStorage, type Storage, type TableName } from './storage.js';

export interface StoreSnapshot { projects: Project[]; services: Service[]; servers: Server[]; jobs: Job[] }
const activeStates = new Set(['queued', 'running', 'unknown']);
const jobStates = new Set(['queued', 'running', 'succeeded', 'failed', 'unknown', 'rolled_back', 'rollback_failed', 'cancelled']);
function text(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}无效`);
}
function date(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('时间格式无效');
}
function id(value: unknown): asserts value is string { text(value, 'ID', 256); if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('ID 格式无效'); }
function clone<T>(value: T): T { return structuredClone(value); }
function environment(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('环境变量格式无效');
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(key) || typeof item !== 'string' || item.includes('\0') || item.length > 65536) throw new Error('环境变量格式无效');
  }
}

/** Public records never contain passwords, tokens or service environment values. */
export class Store {
  readonly rootDirectory: string;
  readonly vault: Vault;
  readonly databaseKind: 'sqlite' | 'postgresql';
  private readonly database: Storage;
  private readonly initialization: Promise<void>;

  constructor(rootDirectory: string, options: { databaseUrl?: string } = {}) {
    this.rootDirectory = privateDirectory(rootDirectory);
    this.database = options.databaseUrl ? new PostgreSQLStorage(options.databaseUrl) : new SQLiteStorage(this.rootDirectory);
    this.databaseKind = this.database.kind;
    this.vault = new Vault(this.rootDirectory, this.database);
    this.initialization = this.vault.ready();
    void this.initialization.catch(() => {});
  }
  async ready(): Promise<void> { await this.initialization; }
  async close(): Promise<void> { await this.database.close(); }
  async allProjects(): Promise<Project[]> { await this.ready(); return (await this.all<Project>('projects')).sort((a,b)=>a.name.localeCompare(b.name)); }
  async allServices(): Promise<Service[]> { await this.ready(); return (await this.all<Service>('services')).sort((a,b)=>a.name.localeCompare(b.name)); }
  async allServers(): Promise<Server[]> { await this.ready(); return (await Promise.all((await this.all<Server>('servers')).map(async server=>({...server,credentialConfigured:await this.vault.has(`ssh:${server.id}`)})))).sort((a,b)=>a.name.localeCompare(b.name)); }
  async allJobs(): Promise<Job[]> { return this.listJobs(); }
  async listJobs(serviceId?: string): Promise<Job[]> {
    await this.ready();
    const rows = serviceId ? await this.database.all<{json:string}>(`SELECT json FROM ${this.database.table('jobs')} WHERE service_id=? ORDER BY created_at DESC,id`,[serviceId]) : await this.database.all<{json:string}>(`SELECT json FROM ${this.database.table('jobs')} ORDER BY created_at DESC,id`);
    return rows.map(row=>JSON.parse(row.json) as Job);
  }
  async getProject(value: string): Promise<Project | undefined> { await this.ready(); return this.get('projects', value); }
  async getService(value: string): Promise<Service | undefined> { await this.ready(); return this.get('services', value); }
  async getServer(value: string): Promise<Server | undefined> { await this.ready(); const server = await this.get<Server>('servers',value); return server ? {...server,credentialConfigured:await this.vault.has(`ssh:${server.id}`)} : undefined; }
  async getJob(value: string): Promise<Job | undefined> { await this.ready(); return this.get('jobs',value); }

  async saveProject(project: Project): Promise<Project> {
    return this.transaction(async()=>{
    const value:Project={id:project.id,name:project.name,description:project.description,serviceIds:clone(project.serviceIds),createdAt:project.createdAt,updatedAt:project.updatedAt}; id(value.id); text(value.name,'项目名称',80); date(value.createdAt); date(value.updatedAt);
    if (typeof value.description !== 'string' || value.description.length > 4000 || !Array.isArray(value.serviceIds) || value.serviceIds.length > 1000 || new Set(value.serviceIds).size !== value.serviceIds.length) throw new Error('项目资料无效');
    for (const serviceId of value.serviceIds) { if (!(await this.getService(serviceId))) throw new Error('项目包含不存在的服务'); }
    for (const existing of (await this.allProjects())) {
      if (existing.id !== value.id && value.serviceIds.some(serviceId=>existing.serviceIds.includes(serviceId))) throw new Error('服务已属于其他项目，请明确移动服务');
    }
    await this.put('projects',value.id,value); return value;

    });
  }
  async moveServices(serviceIds: string[], targetProjectId: string): Promise<void> {
    return this.transaction(async()=>{
    await this.transaction(async()=>{
      const target = (await this.getProject(targetProjectId)); if (!target) throw new Error('目标项目不存在');
      if (new Set(serviceIds).size !== serviceIds.length || (await Promise.all(serviceIds.map(serviceId=>this.getService(serviceId)))).some(service=>!service)) throw new Error('待移动的服务无效');
      for (const project of (await this.allProjects())) {
        if (project.id === targetProjectId) continue;
        project.serviceIds=project.serviceIds.filter(serviceId=>!serviceIds.includes(serviceId)); project.updatedAt=new Date().toISOString(); await this.put('projects',project.id,project);
      }
      target.serviceIds=[...new Set([...target.serviceIds,...serviceIds])]; target.updatedAt=new Date().toISOString(); await this.saveProject(target);
    });

    });
  }
  async removeProject(value: string): Promise<void> {
    return this.transaction(async()=>{ await this.database.run(`DELETE FROM ${this.database.table('projects')} WHERE id=?`,[value]);
    });
  }

  async saveServer(server: Server): Promise<Server> {
    return this.transaction(async()=>{
    const value:Server={id:server.id,name:server.name,host:server.host,port:server.port,username:server.username,group:server.group,notes:server.notes,connectionMode:server.connectionMode,createdAt:server.createdAt,updatedAt:server.updatedAt,...(server.fingerprint?{fingerprint:server.fingerprint}:{})}; id(value.id); text(value.name,'服务器名称',100); text(value.host,'服务器地址',255); text(value.username,'SSH 用户',64); date(value.createdAt); date(value.updatedAt);
    if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]_-]*$/.test(value.host) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value.username) || !Number.isInteger(value.port) || value.port<1 || value.port>65535) throw new Error('服务器地址、用户或端口无效');
    if(value.connectionMode && !['ssh','agent'].includes(value.connectionMode))throw new Error('连接方式无效');
    const previous=(await this.getServer(value.id));
    if (previous && (previous.host!==value.host || previous.port!==value.port || previous.username!==value.username || (previous.connectionMode??'ssh')!==(value.connectionMode??'ssh')) && (await this.allJobs()).some(job=>job.serverId===value.id && activeStates.has(job.state))) throw new Error('服务器还有未结束的任务，不能修改连接地址');
    delete value.credentialConfigured;
    await this.put('servers',value.id,value); return (await this.getServer(value.id))!;

    });
  }
  async removeServer(value: string): Promise<void> {
    return this.transaction(async()=>{
    if ((await this.allServices()).some(service=>service.serverId===value) || (await this.allJobs()).some(job=>job.serverId===value && activeStates.has(job.state))) throw new Error('服务器仍关联服务或未结束任务');
    await this.transaction(async()=>{ await this.database.run(`DELETE FROM ${this.database.table('servers')} WHERE id=?`,[value]); await this.vault.delete(`ssh:${value}`); });

    });
  }
  async saveService(service: Service): Promise<Service> {
    return this.transaction(async()=>{
    const value=clone(service); for (const key of Object.keys(value)) if (!['id','name','kind','serverId','target','image','repository','branch','dockerfile','context','containerPort','hostPort','environment','volumes','autoDeploy','lastCommit','createdAt','updatedAt'].includes(key)) delete (value as unknown as Record<string,unknown>)[key]; id(value.id); text(value.name,'服务名称',253); date(value.createdAt); date(value.updatedAt);
    if (!['compose','kubernetes','container','vercel','image','source'].includes(value.kind) || !value.target || typeof value.target!=='object' || Array.isArray(value.target) || typeof value.autoDeploy!=='boolean') throw new Error('服务资料无效');
    for (const key of Object.keys(value.target)) if (!['composeProject','composeService','namespace','deployment','containerName','vercelProjectId','vercelScopeId','vercelScopeSlug'].includes(key)) delete (value.target as Record<string,unknown>)[key];
    if (value.kind==='vercel') {
      text(value.target.vercelProjectId,'Vercel 项目 ID',256);
      if (value.serverId) throw new Error('Vercel 服务不应绑定服务器');
    } else if (!value.serverId || !(await this.getServer(value.serverId))) throw new Error('服务关联的服务器不存在');
    if (value.kind==='compose') { this.composeName(value.target.composeProject,'Compose 项目'); this.composeName(value.target.composeService,'Compose 服务'); }
    if (value.kind==='container') this.composeName(value.target.containerName,'容器名称');
    if (value.kind==='kubernetes') { this.composeName(value.target.namespace,'Kubernetes namespace'); this.composeName(value.target.deployment,'Kubernetes Deployment'); }
    if (value.environment!==undefined) environment(value.environment);
    if (value.repository) {
      let parsed:URL; try { parsed=new URL(value.repository); } catch { throw new Error('仓库地址无效'); }
      if (parsed.protocol!=='https:' || parsed.hostname!=='github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(parsed.pathname)) throw new Error('仅支持不含凭据的 GitHub HTTPS 仓库地址');
    }
    if (value.branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value.branch) || value.branch.includes('..') || value.branch.includes('//'))) throw new Error('分支名称无效');
    for (const path of [value.dockerfile,value.context]) if (path!==undefined && (typeof path!=='string' || !path || path.startsWith('/') || path.split('/').includes('..') || /[\u0000-\u001f]/.test(path))) throw new Error('构建路径无效');
    for (const port of [value.containerPort,value.hostPort]) if (port!==undefined && (!Number.isInteger(port) || port<1 || port>65535)) throw new Error('服务端口无效');
    if (value.hostPort && !value.containerPort) throw new Error('填写服务器端口时必须填写容器端口');
    const previous=(await this.getService(value.id));
    if (previous && (await this.listJobs(value.id)).some(job=>activeStates.has(job.state)) && (JSON.stringify({...previous,updatedAt:''})!==JSON.stringify({...value,environment:undefined,updatedAt:''}) || (value.environment!==undefined && JSON.stringify((await this.getServiceEnvironment(value.id)))!==JSON.stringify(value.environment)))) throw new Error('服务还有未结束的任务，不能修改部署配置');
    const identity=this.resourceIdentity(value);
    if (identity && (await this.allServices()).some(existing=>existing.id!==value.id && this.resourceIdentity(existing)===identity)) throw new Error('同一服务资源不能重复添加');
    await this.transaction(async()=>{ if (value.environment!==undefined) await this.vault.set(`environment:${value.id}`,value.environment); delete value.environment; await this.put('services',value.id,value); });
    return value;

    });
  }
  async getServiceEnvironment(value: string): Promise<Record<string,string>> { return (await this.vault.get<Record<string,string>>(`environment:${value}`)) ?? {}; }
  async setServiceEnvironment(value: string, variables: Record<string,string>): Promise<void> {
    return this.transaction(async()=>{ if (!(await this.getService(value))) throw new Error('服务不存在'); if ((await this.listJobs(value)).some(job=>activeStates.has(job.state))) throw new Error('服务还有未结束的任务'); environment(variables); await this.vault.set(`environment:${value}`,variables);
    });
  }
  async removeService(value: string): Promise<void> {
    return this.transaction(async()=>{
    if ((await this.listJobs(value)).some(job=>activeStates.has(job.state))) throw new Error('服务还有未结束的任务');
    await this.transaction(async()=>{ for (const project of (await this.allProjects())) { project.serviceIds=project.serviceIds.filter(serviceId=>serviceId!==value); await this.put('projects',project.id,project); } await this.database.run(`DELETE FROM ${this.database.table('services')} WHERE id=?`,[value]); await this.vault.delete(`environment:${value}`); });

    });
  }
  async enqueue(job: Job): Promise<Job> {
    return this.transaction(async()=>{
    if (job.state!=='queued') throw new Error('新任务必须处于等待状态');
    if ((await this.getJob(job.id))) throw new Error('任务 ID 已存在');
    if ((await this.allJobs()).some(existing=>activeStates.has(existing.state) && (job.type==='bootstrap' ? existing.serverId===job.serverId : existing.serviceId===job.serviceId || (existing.serverId===job.serverId && existing.type==='bootstrap')))) throw new Error('目标已有未结束的任务');
    return this.saveJob(job);

    });
  }
  async saveJob(job: Job): Promise<Job> {
    return this.transaction(async()=>{
    const value=clone(job); id(value.id); id(value.serverId); if (value.type!=='bootstrap') id(value.serviceId); date(value.createdAt); date(value.updatedAt); if (value.finishedAt) date(value.finishedAt);
    if (!jobStates.has(value.state) || !['deploy','bootstrap','kubernetes'].includes(value.type) || !['manual','github'].includes(value.source) || typeof value.log!=='string' || value.log.length>4*1024*1024) throw new Error('任务资料无效');
    if(value.type==='kubernetes' && (!value.action || !['restart','stop','start'].includes(value.action))) throw new Error('Kubernetes 操作无效');
    if(value.bootstrap && (value.type!=='bootstrap' || !['docker','k3s'].includes(value.bootstrap.runtime??'docker'))) throw new Error('安装方式无效');
    if (!(await this.getServer(value.serverId))) throw new Error('任务关联的服务器不存在');
    if (value.type!=='bootstrap') { const service=(await this.getService(value.serviceId)); if (!service || service.serverId!==value.serverId || (value.type==='kubernetes' && service.kind!=='kubernetes')) throw new Error('任务关联的服务或服务器不匹配'); }
    const previous=(await this.getJob(value.id));
    if (previous && (previous.serviceId!==value.serviceId || previous.serverId!==value.serverId || previous.type!==value.type || previous.action!==value.action || JSON.stringify(previous.bootstrap)!==JSON.stringify(value.bootstrap) || previous.createdAt!==value.createdAt)) throw new Error('不能改变任务的目标或创建时间');
    await this.database.run(`INSERT INTO ${this.database.table('jobs')} (id,service_id,server_id,state,created_at,json) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,json=excluded.json`,[value.id,value.serviceId,value.serverId,value.state,value.createdAt,JSON.stringify(value)]); return value;

    });
  }
  async updateJob(value: string, changes: Partial<Job>): Promise<Job> {
    return this.transaction(async()=>{ const previous=(await this.getJob(value)); if (!previous) throw new Error('任务不存在'); return this.saveJob({...previous,...clone(changes),id:value});
    });
  }
  async getSetting<T>(key: string): Promise<T | undefined> { await this.ready(); const row=await this.database.get<{json:string}>(`SELECT json FROM ${this.database.table('settings')} WHERE key=?`,[key]); return row ? JSON.parse(row.json) as T : undefined; }
  async setSetting<T>(key: string,value:T): Promise<void> {
    return this.transaction(async()=>{ await this.ready(); text(key,'设置名称'); const json=JSON.stringify(value); if (json===undefined) throw new Error('设置值无效'); await this.database.run(`INSERT INTO ${this.database.table('settings')}(key,json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json`,[key,json]);
    });
  }
  async snapshot(): Promise<StoreSnapshot> { return this.transaction(async()=>({projects:await this.allProjects(),services:await this.allServices(),servers:await this.allServers(),jobs:await this.allJobs()})); }
  async importSnapshot(snapshot: StoreSnapshot, archive?: unknown): Promise<void> {
    await this.transaction(async()=>{
      for (const server of snapshot.servers) await this.saveServer(server);
      for (const service of snapshot.services) await this.saveService(service);
      for (const project of snapshot.projects) await this.saveProject(project);
      for (const job of snapshot.jobs) await this.saveJob(job);
      if (archive!==undefined) await this.vault.set('desktop:archive',archive);
    });
  }
  async transaction<T>(operation:()=>T|Promise<T>): Promise<T> { await this.ready(); return this.database.transaction(operation); }
  private async get<T>(table:TableName,value:string): Promise<T|undefined> { const row=await this.database.get<{json:string}>(`SELECT json FROM ${this.database.table(table)} WHERE id=?`,[value]); return row ? JSON.parse(row.json) as T : undefined; }
  private async all<T>(table:TableName): Promise<T[]> { return (await this.database.all<{json:string}>(`SELECT json FROM ${this.database.table(table)}`)).map(row=>JSON.parse(row.json) as T); }
  private async put<T>(table:TableName,value:string,object:T): Promise<void> { await this.database.run(`INSERT INTO ${this.database.table(table)} (id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`,[value,JSON.stringify(object)]); }
  private composeName(value:unknown,label:string): void { text(value,label,253); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error(`${label}格式无效`); }
  private resourceIdentity(service:Service): string|undefined {
    const target=service.target;
    switch(service.kind) {
      case 'compose':return `compose/${service.serverId}/${target.composeProject}/${target.composeService}`;
      case 'container':return `container/${service.serverId}/${target.containerName}`;
      case 'kubernetes':return `kubernetes/${service.serverId}/${target.namespace}/${target.deployment}`;
      case 'vercel':return `vercel/${target.vercelProjectId}`;
      default:return undefined;
    }
  }
}
