import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import type { Job, Project, Server, Service, ServiceKind } from '../shared/types.js';
import { Store } from './store.js';

type Document = Record<string, any>;
export interface DesktopImportOptions { workspacePath:string; profilesPath:string; store?:Store; destination?:string; databaseUrl?:string }
export interface DesktopImportResult { projects:number; services:number; servers:number; importedProjects:number; importedServices:number; importedServers:number; preservedDeployments:number; preservedAutoDeploymentEvents:number; automaticDeploymentEnabled:false; credentialsImported:false }
function records(database:DatabaseSync,table:string,required=false):Document[] {
  if (!database.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table',table)) {
    if (required) throw new Error(`客户端数据库缺少 ${table} 表`);
    return [];
  }
  return database.prepare(`SELECT id,json FROM ${table}`).all().map(row=>{
    const json = typeof row.json==='string' ? row.json : Buffer.from(row.json as Uint8Array).toString('utf8');
    const value=JSON.parse(json) as Document;
    if (value.id!==row.id) throw new Error(`客户端数据库 ${table} 记录 ID 不匹配`);
    return value;
  });
}
function openReadOnly(path:string):DatabaseSync {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('客户端数据库必须是已存在的普通文件');
  return new DatabaseSync(path,{readOnly:true});
}
function swiftDate(value:unknown,fallback:string):string {
  if (typeof value==='number' && Number.isFinite(value)) return new Date((value+978307200)*1000).toISOString();
  if (typeof value==='string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function stableID(prefix:string,value:string):string { return createHash('sha256').update(`${prefix}/${value}`).digest('hex'); }
function targetSignature(service:Service):string { return JSON.stringify({kind:service.kind,serverId:service.serverId,target:service.target}); }

/** Explicit read-only import. It never connects to a server or enables deployment. */
export async function importDesktop(options:DesktopImportOptions):Promise<DesktopImportResult> {
  if (!options.store && !options.destination) throw new Error('请指定导入目标目录');
  const workspace=openReadOnly(options.workspacePath);
  let profiles:DatabaseSync|undefined;
  let ownedStore:Store|undefined;
  try {
    profiles=openReadOnly(options.profilesPath);
    const workspaceVersion=(workspace.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    const profileVersion=(profiles.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if (![4,5].includes(workspaceVersion) || profileVersion!==1) throw new Error('仅支持包含统一项目资料的客户端数据库（项目版本 4 或 5）');
    const now=new Date().toISOString();
    const rawProfiles=records(profiles,'profiles',true).filter(profile=>!profile.isDeleted);
    const legacyProjects=records(workspace,'projects');
    const legacyVercel=records(workspace,'vercel_projects');
    const legacyDeployments=records(workspace,'deployments');
    const legacyConfigurations=records(workspace,'auto_deployment_configurations');
    const legacyEvents=records(workspace,'auto_deployment_events');
    const rawServices=records(workspace,'workspace_services',true);
    const rawProjects=records(workspace,'workspace_projects',true);
    const byLegacyProject=new Map(legacyProjects.map(project=>[project.id,project]));
    const byVercel=new Map(legacyVercel.map(project=>[project.id,project]));
    const byConfiguration=new Map(legacyConfigurations.map(configuration=>[configuration.id,configuration]));
    const servers:Server[]=rawProfiles.map(profile=>({id:profile.id,name:profile.name,host:profile.host,port:profile.port,username:profile.username,group:profile.group??'',notes:profile.notes??'',createdAt:swiftDate(profile.updatedAt,now),updatedAt:swiftDate(profile.updatedAt,now)}));
    const services:Service[]=rawServices.map(raw=>{
      const base:Service={id:raw.id,name:raw.name,kind:'container',target:{},autoDeploy:false,createdAt:now,updatedAt:now};
      if (raw.image) base.image=raw.image;
      const resource=raw.resource;
      if (!resource || typeof resource!=='object') throw new Error('客户端服务缺少资源引用');
      if (resource.server) {
        const ref=resource.server.reference;
        base.serverId=resource.server.serverID;
        if (ref.runtime==='dockerCompose') { base.kind='compose'; base.target={composeProject:ref.group,composeService:ref.name}; }
        else if (ref.runtime==='kubernetes') { base.kind='kubernetes'; base.target={namespace:ref.group,deployment:ref.name}; }
        else if (ref.runtime==='dockerContainer') { base.kind='container'; base.target={containerName:ref.name}; }
        else throw new Error('客户端服务运行方式无法识别');
      } else if (resource.vercel) {
        const provider=byVercel.get(resource.vercel.projectID);
        if (!provider) throw new Error('Vercel 服务缺少对应的提供方资料');
        base.kind='vercel'; base.target={vercelProjectId:provider.id,vercelScopeId:provider.accountID,vercelScopeSlug:provider.scopeSlug};
      } else if (resource.dockerDeployment) {
        const unit=byLegacyProject.get(resource.dockerDeployment.projectID);
        const definition=unit?.services?.find((item:Document)=>item.id===resource.dockerDeployment.serviceID);
        if (!unit || !definition) throw new Error('Docker 服务缺少原始部署配置');
        base.kind='image'; base.serverId=unit.serverID; base.image=definition.image;
        base.target={composeProject:`sd-${unit.id.toLowerCase().replaceAll('-','')}`,composeService:definition.name};
        base.containerPort=definition.containerPort; base.hostPort=definition.hostPort;
        base.environment=definition.environment??{}; base.volumes=definition.volumes??[];
        base.createdAt=swiftDate(unit.updatedAt,now); base.updatedAt=base.createdAt;
      } else throw new Error('客户端服务资源类型无法识别');
      const configuration=byConfiguration.get(base.id);
      if (configuration) {
        base.repository=configuration.repositoryURL; base.branch=configuration.branch;
        base.dockerfile=configuration.dockerfilePath; base.context=configuration.buildContext;
      }
      return base;
    });
    const projects:Project[]=rawProjects.map(raw=>({id:raw.id,name:raw.name,description:'',serviceIds:raw.serviceIDs,createdAt:swiftDate(raw.updatedAt,now),updatedAt:swiftDate(raw.updatedAt,now)}));
    const byService=new Map(services.map(service=>[service.id,service]));
    const jobs:Job[]=legacyEvents.flatMap(event=>{
      const service=byService.get(event.serviceID);
      if (!service?.serverId) return [];
      const known:Record<string,Job['state']>={succeeded:'succeeded',failed:'failed',rolled_back:'rolled_back',rolledBack:'rolled_back',rollback_failed:'rollback_failed',cancelled:'cancelled'};
      const state=known[event.state]??'unknown';
      const createdAt=swiftDate(event.startedAt,now);
      return [{id:stableID('desktop-event',event.id),serviceId:service.id,serverId:service.serverId,type:'deploy' as const,source:'manual' as const,state,stage:event.stage??'imported',revision:event.revision,log:'从 macOS 客户端导入的历史记录；原始日志已加密保留。',message:'历史记录导入；不会恢复或重新执行任务',createdAt,updatedAt:swiftDate(event.finishedAt,createdAt),...(event.finishedAt?{finishedAt:swiftDate(event.finishedAt,createdAt)}:{})}];
    });
    const store=options.store??(ownedStore=new Store(options.destination!,{databaseUrl:options.databaseUrl}));
    await store.ready();
    for (const incoming of services) {
      const existing=(await store.getService(incoming.id));
      if (existing && targetSignature(existing)!==targetSignature(incoming)) throw new Error('导入服务与目标中已有资源不一致，全部导入已取消');
    }
    // Existing records remain authoritative on repeat import, including regrouping and later edits.
    const existing=await store.snapshot();
    const newServers=servers.filter(server=>!existing.servers.some(item=>item.id===server.id));
    const newServices=services.filter(service=>!existing.services.some(item=>item.id===service.id));
    const newProjects=projects.filter(project=>!existing.projects.some(item=>item.id===project.id));
    const newJobs=jobs.filter(job=>!existing.jobs.some(item=>item.id===job.id));
    (await store.transaction(async ()=>{
      (await store.importSnapshot({servers:newServers,services:newServices,projects:newProjects,jobs:newJobs},{version:1,importedAt:now,projects:legacyProjects,vercelProjects:legacyVercel,deployments:legacyDeployments,autoDeploymentConfigurations:legacyConfigurations,autoDeploymentEvents:legacyEvents}));
      (await store.setSetting('desktopImport',{importedAt:now,projects:projects.length,services:services.length,servers:servers.length,preservedDeployments:legacyDeployments.length,preservedAutoDeploymentEvents:legacyEvents.length,automaticDeploymentEnabled:false,credentialsImported:false}));
    }));
    return {projects:projects.length,services:services.length,servers:servers.length,importedProjects:newProjects.length,importedServices:newServices.length,importedServers:newServers.length,preservedDeployments:legacyDeployments.length,preservedAutoDeploymentEvents:legacyEvents.length,automaticDeploymentEnabled:false,credentialsImported:false};
  } finally { profiles?.close(); workspace.close(); await ownedStore?.close(); }
}
